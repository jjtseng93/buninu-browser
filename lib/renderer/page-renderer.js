/**
 * The page pipeline of one renderer: parse, style, layout, display list and
 * CanvasKit raster, plus the page-side input helpers (scrolling, hit testing,
 * hints). It never touches the network: subresources come through the
 * injected `fetchResource`, which the renderer process forwards to the
 * controller over IPC. Navigation and history belong to the controller;
 * pages ask for navigation through `requestNavigation`.
 *
 * Page scripts run through `page-realm.js` once `setScripting()` enables a
 * mode. DOM changes made by scripts only mark the page dirty; style, layout
 * and raster run when something reads them (hit testing, geometry APIs) or
 * at the next rendering opportunity, which is throttled to the cost of a
 * relayout so timers and animations cannot keep the thread busy.
 *
 * Raster output goes to the compositor (`onFrame`) as tiles: the viewport
 * first, then, when idle, a taller tile around it so the compositor can
 * scroll without waiting for this thread.
 *
 * Documents load in stages: when subresources take longer than
 * PREVIEW_DELAY_MS, a preview styled only by the user-agent defaults and
 * inline <style> is shown and scrollable, then the styled page replaces it,
 * then scripts run. `loadDocument` resolves at the first paint; `whenLoaded`
 * after the load event.
 */
import CanvasKitInit from "../../usr/lib/canvaskit/canvaskit.js";
import { DESKTOP_USER_AGENT } from "../user-agent.js";
import { parseHTMLDocument } from "../happy-dom/parser.js";
import { LayoutEngine } from "../layout/text-layout.js";
import { ScrollViewport } from "../layout/scroll-viewport.js";
import { elementAtPoint, elementBounds, hitTest, interactiveRegions } from "../input/hit-test.js";
import { RenderTreeBuilder, renderTreeText, sameLayoutInput } from "../render-tree/index.js";
import { absolutizeStyleSheetUrls, matchSelectors, StyleEngine, topmostConnected } from "../style/computed-style.js";
import { compileSelector, matchesCompiled } from "../happy-dom/selector-matcher.js";
import { elementFeatures, sheetTraits } from "../style/selector-traits.js";
import { buildDisplayList, visibleItems } from "../paint/display-list.js";
import { backgroundBytes, cropViewport, encodeImage } from "../paint/frame.js";
import { CLASSIC_SCRIPT_TYPES, createPageRealm } from "./page-realm.js";
import { originOf } from "./messaging.js";
import { MOBILE_USER_AGENT } from "./flags.js";
import { formatHint } from "../../vendor/wasmpeg/src/js/formats.js";
import { floatToS16, splitSamples } from "../audio/pcm.js";
import { pianoNote, PianoMixer } from "../audio/piano.js";

// Captured at load: in host mode page scripts share this global object.
const hostPerformance = globalThis.performance;
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostSetInterval = globalThis.setInterval;
const hostClearInterval = globalThis.clearInterval;

/** How long subresources may take before a preview of the unstyled document is shown. */
export const PREVIEW_DELAY_MS = 300;
const MAX_COMPILED_COMPOUNDS = 10_000;

// Media controls: the bar's height over video, and where its parts sit.
const MEDIA_BAR_HEIGHT = 24;
// url(...) in a computed background-image.
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gis;
// Decoded audio already sent, kept so pause/resume continues exactly without decoding again.
const AUDIO_HISTORY_SECONDS = 3;

/**
 * A frame's window as other frames of the page reach it (messaging.js): its
 * place among the frames, its document's origin, and delivery of messages to
 * the realm of whatever document it shows. The page renderer showing the
 * frame attaches itself; until then the frame shows nothing to post to.
 */
export function windowHandle(parent = null, name = "") {
  let target = null;
  // The browsing context name (window.name); it outlives navigations.
  let contextName = String(name);
  const handle = {
    name: () => contextName,
    setName(value) {
      contextName = String(value);
    },
    parent: () => parent,
    top: () => parent ? parent.top() : handle,
    origin: () => target?.origin() ?? "null",
    post: (message) => target?.post(message),
    closed: () => target?.closed() ?? false,
    children: () => target?.children() ?? [],
    global: () => target?.global() ?? null,
    document: () => target?.document() ?? null,
    attach(renderer) {
      target = renderer;
    },
  };
  return handle;
}

/**
 * CanvasKit and the bundled fonts, loaded once per process: a page and the
 * documents of its iframes draw with the same CanvasKit instance (images
 * cannot move between instances), and the files are read before the
 * renderer's sandbox closes.
 */
let graphics = null;
// The same, once loaded: an embedding page makes its iframes' renderers with it synchronously.
let loadedGraphics = null;
export function loadGraphics() {
  return graphics ??= (async () => {
    const wasmBinary = await Bun.file(new URL("canvaskit.wasm", canvasKitDirectory)).arrayBuffer();
    const CanvasKit = await CanvasKitInit({ wasmBinary });
    const fontCatalogue = await Bun.file(new URL("fonts.json", fontDirectory)).json();
    const uiFontNames = [fontCatalogue.sets.ui.regular, ...fontCatalogue.sets.ui.fallback];
    const monospaceFontNames = [fontCatalogue.sets.terminal.regular, fontCatalogue.sets.terminal.bold];
    const fontBuffers = await Promise.all([...uiFontNames, ...monospaceFontNames].map((name) =>
      Bun.file(new URL(fontCatalogue.fonts[name].file, fontDirectory)).arrayBuffer()));
    // A TypefaceFontProvider registers each file under an explicit family name.
    // CanvasKit does not pick a static bold face by weight within one family, so
    // the monospace bold file gets its own catalogue name and is chosen by weight.
    const fontProvider = CanvasKit.TypefaceFontProvider.Make();
    const loadedFamilies = new Map();
    [...uiFontNames, ...monospaceFontNames].forEach((name, index) => {
      const family = (fontCatalogue.fonts[name].families ?? [name])[0];
      fontProvider.registerFont(fontBuffers[index], family);
      loadedFamilies.set(family.toLowerCase(), family);
    });
    // One font collection for every paragraph: building each paragraph from
    // the provider made a new collection, so Skia's font matching and fallback
    // caches started cold every time (about 3x slower per paragraph).
    const fontCollection = CanvasKit.FontCollection.Make();
    fontCollection.setDefaultFontManager(fontProvider);
    fontCollection.enableFontFallback();

    const fontFamilies = uiFontNames.map((name) => (fontCatalogue.fonts[name].families ?? [name])[0]);
    const sansSerifFamily = fontFamilies[0];
    const monospaceFamily = fontCatalogue.sets.terminal.regular;
    const monospaceBoldFamily = fontCatalogue.sets.terminal.bold;
    // Maps CSS generic and common platform family names onto the bundled fonts.
    const genericFamilies = new Map([
      ["monospace", monospaceFamily], ["ui-monospace", monospaceFamily], ["menlo", monospaceFamily],
      ["consolas", monospaceFamily], ["monaco", monospaceFamily], ["courier", monospaceFamily],
      ["courier new", monospaceFamily], ["sans-serif", sansSerifFamily], ["serif", sansSerifFamily],
      ["system-ui", sansSerifFamily], ["-apple-system", sansSerifFamily], ["blinkmacsystemfont", sansSerifFamily],
      ["ui-sans-serif", sansSerifFamily], ["arial", sansSerifFamily], ["helvetica", sansSerifFamily],
    ]);
    return loadedGraphics = {
      CanvasKit, loadedFamilies, fontCollection, fontFamilies, sansSerifFamily, monospaceFamily, monospaceBoldFamily,
      genericFamilies,
    };
  })();
}

/**
 * Horizontal layout of a media control bar `width` CSS pixels wide: the
 * play/pause mark takes the first 30, then "m:ss / m:ss" when there is room,
 * then the progress track that clicks seek.
 */
export function mediaBarLayout(width) {
  const timeWidth = width >= 200 ? 86 : 0;
  const trackStart = 30 + timeWidth;
  return { timeStart: 30, timeWidth, trackStart, trackEnd: Math.max(trackStart + 10, width - 12) };
}

export function formatMediaTime(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const canvasKitDirectory = new URL("../../usr/lib/canvaskit/", import.meta.url);
const fontDirectory = new URL("../../usr/share/fonts/", import.meta.url);

/**
 * @param {{
 *   fetchResource(url: string, kind: "stylesheet" | "image" | "script" | "metadata" | "video"):
 *     Promise<{ ok: boolean, status: number, url: string, contentType: string, body: Uint8Array }>,
 *   requestNavigation?(url: string, downloadName?: string | null, fragmentFrom?: { x: number, y: number } | null): void,
 *   requestDownload?(payload: { url: string, name: string, data: Uint8Array }): void,
 *   reportError?(message: string): void,
 *   pageFetch?(request: object): Promise<object>,
 *   webSockets?: { open(url, protocols, onEvent): number, send(id, data): void, close(id, code, reason): void } | null,
 *   audio?: { open(options, onEvent): number, write(id, data): void, finish(id): void, close(id): void } | null,
 *   setCookie?(value: string): void,
 *   consoleMessage?: ((level: string, text: string) => void) | null,
 *   trace?: ((text: string) => void) | null,
 *   onFrame?: ((frame: object) => void) | null,
 *   onLifecycle?: ((name: "DOMContentLoaded" | "load", generation: number) => void) | null,
 *   videoDecoder?: object | null,
 * }} options
 */
export async function createPageRenderer(options) {
  return buildPageRenderer(options, await loadGraphics());
}

/** createPageRenderer with the graphics already loaded. */
function buildPageRenderer({
  fetchResource: rawFetchResource,
  requestNavigation = () => {},
  requestDownload = () => {},
  reportError = () => {},
  pageFetch = () => Promise.reject(new TypeError("network access is not available")),
  webSockets = null,
  audio = null,
  setCookie = () => {},
  consoleMessage = null,
  trace = null,
  onFrame = null,
  onLifecycle = null,
  videoDecoder = null,
  mobile = false,
  verifyStyle = false,
  fullStyle = false,
  // An iframe's document (see syncFrames): frames go to the embedding page,
  // which needs only the viewport, so nothing is painted ahead.
  embedded = false,
  // This document's window handle, made by the embedding page (see windowHandle).
  frameWindow = null,
}, {
  CanvasKit, loadedFamilies, fontCollection, fontFamilies, sansSerifFamily, monospaceFamily, monospaceBoldFamily,
  genericFamilies,
}) {
  const resolvedFamilies = new Map();
  /** First available family from a computed font-family list, then the UI fallbacks. */
  function resolveFontFamilies(families = ["sans-serif"], weight = 400) {
    const bold = weight >= 600;
    const key = `${bold}\n${families.join("\n")}`;
    let resolved = resolvedFamilies.get(key);
    if (!resolved) {
      let primary = families
        .map((family) => loadedFamilies.get(family.toLowerCase()) ?? genericFamilies.get(family.toLowerCase()))
        .find(Boolean) ?? sansSerifFamily;
      if (bold && primary === monospaceFamily) primary = monospaceBoldFamily;
      resolved = [primary, ...fontFamilies.filter((family) => family !== primary)];
      resolvedFamilies.set(key, resolved);
    }
    return resolved;
  }
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const emojiPresentation = /^\p{Emoji_Presentation}/u;
  const renderTreeBuilder = new RenderTreeBuilder();
  const layoutEngine = new LayoutEngine({ measureText, fontMetrics });
  const styleEngine = new StyleEngine();
  // Incremental restyle: what may have changed style since the last
  // computation. DOM mutations come from a MutationObserver; state that is
  // not in the DOM tree (checked, value, focus) is marked by the code that
  // changes it. `full` asks for a complete restyle.
  const styleChanges = { full: true, roots: new Set(), rootFeatures: new Map(), records: [], observer: null, activeElement: null };
  let selectorTraits = { sibling: false, has: null, sheets: null };
  let lastStyleParts = "";
  let laidOutSheets = null;
  const sheetTraitsCache = new Map();
  // Invalidation compounds compiled for matchesCompound() and matchSelectors().
  const compiledCompounds = new Map();
  let lastStyleReason = "";
  let hasState = null;
  let hasStateStale = false;
  let structuralState = null;
  let siblingState = null;
  // iframes (see syncFrames), by element.
  const frames = new Map();
  let disposedRenderer = false;
  const ownWindow = frameWindow ?? windowHandle(null);
  ownWindow.attach({
    // An iframe's about:blank document has the origin of the page that made it.
    origin: () => page.url === "about:blank" && ownWindow.parent() ? ownWindow.parent().origin() : originOf(page.url),
    post: (message) => page.realm?.receiveMessage(message),
    closed: () => disposedRenderer,
    children: () => [...frames.values()].map((frame) => frame.window),
    global: () => page.realm?.pageGlobal ?? null,
    document: () => page.realm?.documentBinding ?? null,
  });
  // Changes whenever a frame's image does, so the page is rasterized again.
  let framesVersion = 0;
  let framePaintTimer = null;
  // The frame keyboard input goes to, after a click into it.
  let focusedFrame = null;
  const viewport = new ScrollViewport(800, 600);
  const page = {
    url: "about:blank",
    title: "",
    document: null,
    renderTree: null,
    layout: null,
    displayList: null,
    window: null,
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    pageScale: 1,
    needsPaint: true,
    loading: false,
    hints: [],
    hintsVisible: false,
    styleSheets: [],
    linkSheets: null,
    // The document's scripts fetched ahead of their turn (see preloadScripts), by URL.
    preloadedScripts: new Map(),
    backgroundColor: "rgba(255, 255, 255, 1)",
    resources: new WeakMap(),
    decodedImages: [],
    imagesLoaded: null,
    // CSS background images by absolute URL: { resource, loaded } (see queueBackgroundImages).
    backgrounds: new Map(),
    // Scroll offsets of scroll containers, by element (see setElementScroll).
    elementScroll: new Map(),
    // <video> and <audio> playback states, by element (see playMedia).
    media: new Map(),
    realm: null,
    // "off" until the renderer process has set up its sandbox.
    scripting: "off",
    dirty: false,
    resourceLayoutDirty: false,
    userAgent: mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
    // document.cookie as last reported by the controller (non-HttpOnly only).
    cookie: "",
  };

  async function fetchResource(url, kind) {
    const response = await rawFetchResource(url, kind);
    if (typeof response.documentCookie === "string") page.cookie = response.documentCookie;
    return response;
  }

  function makeParagraph(text, computedStyle = null, fontSize = computedStyle?.fontSize ?? 16, scale = 1) {
    const color = canvasColor(CanvasKit, computedStyle?.color ?? "rgba(0, 0, 0, 1)");
    const weight = computedStyle?.fontWeight ?? 400;
    const families = resolveFontFamilies(computedStyle?.fontFamily, weight);
    const emojiFontFamilies = [
      ...families.filter((name) => name.includes("Emoji")),
      ...families.filter((name) => !name.includes("Emoji")),
    ];
    // text-decoration lines, drawn by SkParagraph under/over/through the glyphs.
    const decoration = computedStyle?.decoration ? {
      decoration: computedStyle.decoration.lines.reduce((mask, line) => mask | ({
        underline: CanvasKit.UnderlineDecoration, overline: CanvasKit.OverlineDecoration, "line-through": CanvasKit.LineThroughDecoration,
      })[line], 0),
      decorationColor: canvasColor(CanvasKit, computedStyle.decoration.color),
      decorationThickness: 1,
    } : {};
    const style = new CanvasKit.ParagraphStyle({
      textStyle: {
        color,
        fontFamilies: families,
        fontSize: Math.max(1, Math.round(fontSize * scale)),
        fontStyle: { weight },
        // Roboto is a variable font; static fonts ignore the axis and match by weight.
        fontVariations: [{ axis: "wght", value: weight }],
        ...decoration,
      },
      maxLines: 1,
    });
    const builder = CanvasKit.ParagraphBuilder.MakeFromFontCollection(style, fontCollection);
    for (const { segment } of graphemes.segment(text || " ")) {
      const emoji = emojiPresentation.test(segment) || segment.includes("\uFE0F");
      if (emoji) {
        builder.pushStyle(CanvasKit.TextStyle({
          color,
          ...decoration,
          fontFamilies: emojiFontFamilies,
          fontSize: Math.max(1, Math.round(fontSize * scale)),
          fontStyle: { weight: computedStyle?.fontWeight ?? 400 },
        }));
      }
      builder.addText(segment);
      if (emoji) builder.pop();
    }
    const paragraph = builder.build();
    builder.delete();
    return paragraph;
  }

  // Text widths depend only on the font (families, rounded size, weight),
  // not on the element, so they are cached per font across elements,
  // relayouts and documents. The cache is dropped when it grows too large.
  const MAX_MEASURED_TEXTS = 200_000;
  const measuredWidths = new Map();
  let measuredCount = 0;

  function measureText(text, computedStyle = null) {
    if (!text) return 0;
    const fontKey = fontKeyOf(computedStyle);
    let widths = measuredWidths.get(fontKey);
    if (!widths) measuredWidths.set(fontKey, widths = new Map());
    let width = widths.get(text);
    if (width === undefined) {
      const paragraph = makeParagraph(text, computedStyle);
      paragraph.layout(100_000);
      // getLongestLine() drops trailing white space, which line breaking needs.
      width = paragraph.getMaxIntrinsicWidth();
      paragraph.delete();
      if (++measuredCount > MAX_MEASURED_TEXTS) {
        measuredWidths.clear();
        measuredCount = 1;
        measuredWidths.set(fontKey, widths = new Map());
      }
      widths.set(text, width);
    }
    return width;
  }

  // Computed styles are immutable and shared, so each one's key is computed once.
  const fontKeys = new WeakMap();
  function fontKeyOf(computedStyle) {
    if (computedStyle && typeof computedStyle === "object") {
      const cached = fontKeys.get(computedStyle);
      if (cached) return cached;
    }
    const weight = computedStyle?.fontWeight ?? 400;
    const key = `${Math.max(1, Math.round(computedStyle?.fontSize ?? 16))}/${weight}/${
      resolveFontFamilies(computedStyle?.fontFamily, weight).join(",")}`;
    if (computedStyle && typeof computedStyle === "object") fontKeys.set(computedStyle, key);
    return key;
  }

  const fontMetricsCache = new Map();
  function fontMetrics(computedStyle = null) {
    const key = `${computedStyle?.fontSize ?? 16}/${computedStyle?.fontWeight ?? 400}/${computedStyle?.fontFamily?.join(",")}`;
    let metrics = fontMetricsCache.get(key);
    if (!metrics) {
      const paragraph = makeParagraph("Hg", computedStyle);
      paragraph.layout(100_000);
      metrics = { ascent: paragraph.getAlphabeticBaseline(), height: paragraph.getHeight() };
      paragraph.delete();
      fontMetricsCache.set(key, metrics);
    }
    return metrics;
  }

  // Compositor state. The compositor owns scrolling; `syncedScroll` is the
  // position both sides agree on, and `scrollEpoch` changes whenever this
  // thread scrolls on its own (keys, fragments, script, a new document).
  let scrollEpoch = 0;
  let syncedScroll = { x: 0, y: 0 };
  let tileSerial = 0;
  let lastTile = null;
  let encoded = { key: "", png: "" };
  let prepaintTimer = null;
  let frameTimer = null;
  let lastRebuildMs = 0;

  // What the latest tile was rasterized from. A rebuild that produces the
  // same display list (script changes that do not affect rendering, repeated
  // relayouts) reuses the tile instead of rasterizing again, like Blink's
  // PaintController reusing cached display items
  // (platform/graphics/paint/paint_controller.cc, BSD).
  let rasterized = { list: null, overlay: "", background: "", scale: 0 };

  /** Hint overlay contents, as a comparable key. */
  function overlayKey() {
    const hints = page.hintsVisible
      ? page.hints.map((hint) => `${hint.label}@${hint.x + hint.scrollX},${hint.y + hint.scrollY}`).join(";")
      : "";
    return hints;
  }

  function sameRasterInput() {
    if (rasterized.scale !== page.deviceScaleFactor || rasterized.background !== page.backgroundColor) return false;
    if (rasterized.overlay !== overlayKey()) return false;
    if (rasterized.frames !== framesVersion) return false;
    if (page.displayList?.items.some((item) => item.fixed)
      && (rasterized.scrollX !== viewport.x || rasterized.scrollY !== viewport.y)) return false;
    if (rasterized.list === page.displayList) return true;
    if (!rasterized.list || !page.displayList || !Bun.deepEquals(rasterized.list.items, page.displayList.items)) return false;
    rasterized.list = page.displayList;
    return true;
  }

  /** Rasterizes the viewport and hands it to the compositor. */
  function render() {
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const region = { x: viewport.x, y: viewport.y, width, height };
    if (lastTile && tileCovers(lastTile, region) && sameRasterInput()) {
      page.needsPaint = false;
      // Only this thread's scroll position changed: tell the compositor.
      if (viewport.x !== syncedScroll.x || viewport.y !== syncedScroll.y) publish(lastTile);
    } else {
      publish(rasterTile(region));
    }
    schedulePrepaint();
  }

  /** Rasterizes a page rectangle (CSS pixels) into RGBA pixels. */
  function rasterTile(region) {
    const scale = page.deviceScaleFactor;
    const pixelWidth = Math.max(1, Math.round(region.width * scale));
    const pixelHeight = Math.max(1, Math.round(region.height * scale));
    const surface = CanvasKit.MakeSurface(pixelWidth, pixelHeight);
    if (!surface) throw new Error(`Unable to create a ${pixelWidth}x${pixelHeight} CanvasKit surface`);
    const canvas = surface.getCanvas();
    canvas.clear(canvasColor(CanvasKit, page.backgroundColor));
    paintDisplayList(canvas, page.displayList, region, scale);
    drawHints(canvas, region);
    surface.flush();
    const image = surface.makeImageSnapshot();
    const pixels = image.readPixels(0, 0, {
      width: pixelWidth,
      height: pixelHeight,
      colorType: CanvasKit.ColorType.RGBA_8888,
      alphaType: CanvasKit.AlphaType.Unpremul,
      colorSpace: CanvasKit.ColorSpace.SRGB,
    });
    image.delete();
    surface.delete();
    page.needsPaint = false;
    rasterized = {
      list: page.displayList, overlay: overlayKey(), background: page.backgroundColor, scale: page.deviceScaleFactor,
      scrollX: viewport.x, scrollY: viewport.y, frames: framesVersion,
    };
    return {
      pixels,
      pixelWidth,
      pixelHeight,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      scale,
      background: backgroundBytes(page.backgroundColor),
    };
  }

  function publish(tile) {
    lastTile = tile;
    tileSerial++;
    if (viewport.x !== syncedScroll.x || viewport.y !== syncedScroll.y) {
      scrollEpoch++;
      syncedScroll = { x: viewport.x, y: viewport.y };
    }
    onFrame?.({
      tile,
      viewport: { width: page.width, height: page.height },
      content: { width: viewport.contentWidth, height: viewport.contentHeight },
      scroll: { ...syncedScroll },
      scrollEpoch,
    });
  }

  /** The region the idle prepaint covers: half a viewport above, one below. */
  function prepaintRegion() {
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const top = Math.max(0, Math.floor(viewport.y - height / 2));
    const bottom = Math.max(top + height, Math.min(Math.ceil(viewport.contentHeight), Math.ceil(viewport.y + height * 2)));
    return { x: viewport.x, y: top, width, height: bottom - top };
  }

  function tileCovers(tile, region) {
    return tile && tile.scale === page.deviceScaleFactor
      && tile.x === region.x && tile.width === region.width
      && tile.y <= region.y && tile.y + tile.height >= region.y + region.height;
  }

  /** After a paint or a compositor scroll, rasterize around the viewport once this thread is idle. */
  function schedulePrepaint() {
    if (!onFrame || embedded) return;
    hostClearTimeout(prepaintTimer);
    prepaintTimer = hostSetTimeout(() => {
      prepaintTimer = null;
      // A pending relayout does not stop this: the current layout, even if
      // slightly stale, is better than background where the user scrolled.
      const width = Math.max(1, Math.floor(page.width));
      const height = Math.max(1, Math.floor(page.height));
      // Still covered with a quarter viewport to spare in both directions
      // (as far as the page goes).
      const top = Math.max(0, viewport.y - height / 4);
      const bottom = Math.max(viewport.y + height, Math.min(viewport.contentHeight, viewport.y + height * 1.25));
      if (tileCovers(lastTile, { x: viewport.x, y: top, width, height: bottom - top }) && sameRasterInput()) return;
      publish(rasterTile(prepaintRegion()));
    }, 30);
  }

  /** A rendering opportunity for DOM changes nobody has asked to see yet. */
  function scheduleFrame() {
    if (!onFrame || frameTimer || page.loading) return;
    frameTimer = hostSetTimeout(() => {
      frameTimer = null;
      refresh();
    // Leave one rebuild-sized idle window after an expensive frame. Without
    // it, a large document can spend all its time producing back-to-back
    // frames while scripts are still making related mutations.
    }, Math.max(50, lastRebuildMs * 2));
  }

  /** The viewport as a PNG (base64), cut from the latest tile. */
  async function viewportPng() {
    if (!lastTile) return "";
    const key = `${tileSerial}:${viewport.x}:${viewport.y}`;
    if (encoded.key !== key) {
      const { pixels, width, height } = cropViewport(lastTile, viewport.x, viewport.y, page.width, page.height);
      encoded = { key, png: Buffer.from(await encodeImage(pixels, width, height)).toString("base64") };
    }
    return encoded.png;
  }

  /** Rasterizes display items intersecting the viewport onto a CanvasKit canvas. */
  const paintFailures = new Set();

  function paintDisplayList(canvas, displayList, view, scale) {
    if (!displayList) return;
    const pixel = (value) => Math.round(value * scale);
    const deviceRect = (rect) => CanvasKit.XYWHRect(
      pixel(rect.x - view.x), pixel(rect.y - view.y), pixel(rect.width), pixel(rect.height),
    );
    const deviceRRect = (rect, radii) => radii && (radii.x > 0 || radii.y > 0)
      ? CanvasKit.RRectXY(deviceRect(rect), radii.x * scale, radii.y * scale)
      : null;
    // Returns a paint plus a release function that also frees its shader.
    const fillPaint = (item) => {
      const paint = new CanvasKit.Paint();
      const shader = item.gradient ? gradientShader(item.gradient, view, scale) : null;
      if (shader) paint.setShader(shader);
      else paint.setColor(canvasColor(CanvasKit, item.color));
      paint.release = () => {
        shader?.delete();
        paint.delete();
      };
      return paint;
    };
    const drawBox = (rect, radii, paint) => {
      const rounded = deviceRRect(rect, radii);
      if (rounded) canvas.drawRRect(rounded, paint);
      else canvas.drawRect(deviceRect(rect), paint);
    };
    for (const item of visibleItems(displayList, view, viewport)) {
      const saved = item.fixed || item.clipRect || item.opacity < 1 || item.transform ? canvas.save() : null;
      try {
        if (item.fixed) canvas.translate(viewport.x * scale, viewport.y * scale);
        if (item.clipRect) canvas.clipRect(deviceRect(item.clipRect), CanvasKit.ClipOp.Intersect, true);
        // A scale in document space, as a device-space matrix around the item's device coordinates.
        if (item.transform) {
          const { a, d, e, f } = item.transform;
          canvas.concat([a, 0, ((a - 1) * view.x + e) * scale, 0, d, ((d - 1) * view.y + f) * scale, 0, 0, 1]);
        }
        if (item.opacity < 1) {
          const layer = new CanvasKit.Paint();
          layer.setAlphaf(item.opacity);
          canvas.saveLayer(layer, deviceRect(item.bounds));
          layer.delete();
        }
        paintItem(item);
      } catch (error) {
        // One failing item must not take down the page or the browser process.
        if (!paintFailures.has(item.op)) {
          paintFailures.add(item.op);
          process.stderr.write(`paint ${item.op} failed: ${error?.message ?? error}\n`);
        }
      } finally {
        if (saved !== null) canvas.restoreToCount(saved);
      }
    }

    // Inline SVG: shapes in viewBox units, fitted into the box (xMidYMid meet).
    function drawSvg(item) {
      const { svg, rect } = item;
      const [viewX, viewY, viewWidth, viewHeight] = svg.viewBox ?? [0, 0, rect.width, rect.height];
      const fit = Math.min(rect.width / viewWidth, rect.height / viewHeight);
      const offsetX = (rect.width - viewWidth * fit) / 2;
      const offsetY = (rect.height - viewHeight * fit) / 2;
      canvas.save();
      canvas.clipRect(deviceRect(rect), CanvasKit.ClipOp.Intersect, true);
      canvas.translate((rect.x - view.x + offsetX) * scale, (rect.y - view.y + offsetY) * scale);
      canvas.scale(fit * scale, fit * scale);
      canvas.translate(-viewX, -viewY);
      const paint = new CanvasKit.Paint();
      paint.setAntiAlias(true);
      const colorWithAlpha = (color, alpha) => {
        const value = canvasColor(CanvasKit, color);
        value[3] *= alpha;
        return value;
      };
      for (const shape of svg.shapes) {
        const path = CanvasKit.Path.MakeFromSVGString(shape.d);
        if (!path) continue;
        path.setFillType(shape.fillRule === "evenodd" ? CanvasKit.FillType.EvenOdd : CanvasKit.FillType.Winding);
        const [a, b, c, d, e, f] = shape.matrix;
        canvas.save();
        canvas.concat([a, c, e, b, d, f, 0, 0, 1]);
        if (shape.fill && shape.fillOpacity > 0) {
          paint.setStyle(CanvasKit.PaintStyle.Fill);
          paint.setColor(colorWithAlpha(shape.fill, shape.fillOpacity));
          canvas.drawPath(path, paint);
        }
        if (shape.stroke && shape.strokeOpacity > 0 && shape.strokeWidth > 0) {
          paint.setStyle(CanvasKit.PaintStyle.Stroke);
          paint.setStrokeWidth(shape.strokeWidth);
          paint.setColor(colorWithAlpha(shape.stroke, shape.strokeOpacity));
          canvas.drawPath(path, paint);
        }
        canvas.restore();
        path.delete();
      }
      paint.delete();
      canvas.restore();
    }

    function paintItem(item) {
      if (item.op === "fillRect") {
        const paint = fillPaint(item);
        drawBox(item.rect, item.radii, paint);
        paint.release();
      } else if (item.op === "border") {
        paintBorder(canvas, item, view, scale);
      } else if (item.op === "drawShadow") {
        const paint = new CanvasKit.Paint();
        paint.setAntiAlias(true);
        paint.setColor(canvasColor(CanvasKit, item.color));
        // Blink converts a CSS blur radius to a Gaussian sigma of blur / 2.
        const filter = item.blur > 0
          ? CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, pixel(item.blur) / 2, true)
          : null;
        if (filter) paint.setMaskFilter(filter);
        canvas.save();
        const clip = deviceRRect(item.clip, item.clipRadii);
        if (clip) canvas.clipRRect(clip, CanvasKit.ClipOp.Difference, true);
        else canvas.clipRect(deviceRect(item.clip), CanvasKit.ClipOp.Difference, true);
        drawBox(item.rect, item.radii, paint);
        canvas.restore();
        filter?.delete();
        paint.delete();
      } else if (item.op === "drawImage") {
        const resource = displayList.images[item.image];
        canvas.save();
        const clip = deviceRRect(item.rect, item.radii);
        if (clip) canvas.clipRRect(clip, CanvasKit.ClipOp.Intersect, true);
        canvas.drawImageRect(
          resource.image,
          CanvasKit.XYWHRect(0, 0, resource.width, resource.height),
          deviceRect(item.rect),
          null,
          false,
        );
        canvas.restore();
      } else if (item.op === "drawBackgroundImage") {
        // Tiles from an image shader, repeating (or not) per axis.
        const resource = displayList.images[item.image];
        const { tile } = item;
        canvas.save();
        const clip = deviceRRect(item.rect, item.radii);
        if (clip) canvas.clipRRect(clip, CanvasKit.ClipOp.Intersect, true);
        const matrix = CanvasKit.Matrix.multiply(
          CanvasKit.Matrix.translated((tile.x - view.x) * scale, (tile.y - view.y) * scale),
          CanvasKit.Matrix.scaled(tile.width * scale / resource.width, tile.height * scale / resource.height),
        );
        const shader = resource.image.makeShaderOptions(
          item.repeatX ? CanvasKit.TileMode.Repeat : CanvasKit.TileMode.Decal,
          item.repeatY ? CanvasKit.TileMode.Repeat : CanvasKit.TileMode.Decal,
          CanvasKit.FilterMode.Linear,
          CanvasKit.MipmapMode.None,
          matrix,
        );
        const paint = new CanvasKit.Paint();
        paint.setShader(shader);
        canvas.drawRect(deviceRect(item.bounds), paint);
        paint.delete();
        shader.delete();
        canvas.restore();
      } else if (item.op === "drawVideo") {
        const resource = displayList.images[item.image];
        const rect = deviceRect(item.rect);
        const paint = new CanvasKit.Paint();
        canvas.save();
        canvas.clipRect(rect, CanvasKit.ClipOp.Intersect, true);
        paint.setColor(CanvasKit.Color(0, 0, 0, 1));
        canvas.drawRect(rect, paint);
        if (resource?.image) {
          canvas.drawImageRect(resource.image,
            CanvasKit.XYWHRect(0, 0, resource.bitmapWidth ?? resource.width, resource.bitmapHeight ?? resource.height),
            rect, null, false);
        }
        const centerX = rect[0] + (rect[2] - rect[0]) / 2;
        const centerY = rect[1] + (rect[3] - rect[1]) / 2;
        paint.setColor(CanvasKit.Color(0, 0, 0, 0.65));
        if (!resource?.playing) {
          canvas.drawCircle(centerX, centerY, 22 * scale, paint);
          paint.setColor(CanvasKit.Color(255, 255, 255, 1));
          const path = CanvasKit.Path.MakeFromSVGString(
            `M ${centerX - 6 * scale} ${centerY - 10 * scale} L ${centerX + 11 * scale} ${centerY} L ${centerX - 6 * scale} ${centerY + 10 * scale} Z`);
          if (path) { canvas.drawPath(path, paint); path.delete(); }
        }
        // The control bar (play/pause, time, seekable progress) once playing or known.
        if (resource?.playing || Number.isFinite(resource?.duration)) {
          drawMediaBar(canvas, item.rect.x - view.x, item.rect.y + item.rect.height - MEDIA_BAR_HEIGHT - view.y,
            item.rect.width, MEDIA_BAR_HEIGHT, resource, scale, true);
        }
        paint.delete();
        canvas.restore();
      } else if (item.op === "drawAudio") {
        const resource = displayList.images[item.image];
        drawMediaBar(canvas, item.rect.x - view.x, item.rect.y - view.y, item.rect.width, item.rect.height, resource, scale, false);
      } else if (item.op === "drawSvg") {
        drawSvg(item);
      } else if (item.op === "drawText") {
        const textStyle = {
          color: item.color, fontSize: item.font.size, fontWeight: item.font.weight, fontFamily: item.font.family,
          decoration: item.decoration,
        };
        const paragraph = makeParagraph(item.text, textStyle, undefined, scale);
        paragraph.layout(pixel(Math.max(1, view.width + view.x - item.x)));
        if (item.gradient) {
          // background-clip:text: draw glyphs, then keep the gradient only where they are.
          canvas.saveLayer(null, deviceRect(item.bounds));
          canvas.drawParagraph(paragraph, pixel(item.x - view.x), pixel(item.y - view.y));
          const paint = fillPaint(item);
          paint.setBlendMode(CanvasKit.BlendMode.SrcIn);
          canvas.drawRect(deviceRect(item.bounds), paint);
          paint.release();
          canvas.restore();
        } else {
          canvas.drawParagraph(paragraph, pixel(item.x - view.x), pixel(item.y - view.y));
        }
        paragraph.delete();
      }
    }
  }

  /**
   * Paints a border as the ring between the outer and inner rounded rects.
   * Differently coloured sides are each clipped to the trapezoid running from
   * the outer to the inner corners, so a single side follows the corner curve.
   * Every style is currently painted solid.
   */
  function paintBorder(canvas, item, view, scale) {
    const [top, right, bottom, left] = item.widths.map((width) => width * scale);
    const X0 = (item.rect.x - view.x) * scale;
    const Y0 = (item.rect.y - view.y) * scale;
    const X1 = X0 + item.rect.width * scale;
    const Y1 = Y0 + item.rect.height * scale;
    const rx = item.radii.x * scale;
    const ry = item.radii.y * scale;
    const [x0, y0, x1, y1] = [X0 + left, Y0 + top, Math.max(X0 + left, X1 - right), Math.max(Y0 + top, Y1 - bottom)];
    const outer = Float32Array.of(X0, Y0, X1, Y1, rx, ry, rx, ry, rx, ry, rx, ry);
    const inner = Float32Array.of(x0, y0, x1, y1,
      Math.max(0, rx - left), Math.max(0, ry - top), Math.max(0, rx - right), Math.max(0, ry - top),
      Math.max(0, rx - right), Math.max(0, ry - bottom), Math.max(0, rx - left), Math.max(0, ry - bottom));
    const sides = [
      [X0, Y0, X1, Y0, x1, y0, x0, y0],
      [X1, Y0, X1, Y1, x1, y1, x1, y0],
      [X1, Y1, X0, Y1, x0, y1, x1, y1],
      [X0, Y1, X0, Y0, x0, y0, x0, y1],
    ];
    const uniform = item.colors.every((color, index) =>
      color === item.colors[0] && (item.widths[index] > 0) === (item.widths[0] > 0));
    const paint = new CanvasKit.Paint();
    paint.setAntiAlias(true);
    if (uniform) {
      paint.setColor(canvasColor(CanvasKit, item.colors[0]));
      canvas.drawDRRect(outer, inner, paint);
    } else {
      sides.forEach((points, index) => {
        if (!(item.widths[index] > 0)) return;
        // CanvasKit paths are immutable; build the trapezoid with a PathBuilder.
        const builder = new CanvasKit.PathBuilder();
        builder.addPolygon(Float32Array.from(points), true);
        const path = builder.detachAndDelete();
        canvas.save();
        canvas.clipPath(path, CanvasKit.ClipOp.Intersect, true);
        paint.setColor(canvasColor(CanvasKit, item.colors[index]));
        canvas.drawDRRect(outer, inner, paint);
        canvas.restore();
        path.delete();
      });
    }
    paint.delete();
  }

  function gradientShader(gradient, view, scale) {
    const colors = gradient.stops.map((stop) => canvasColor(CanvasKit, stop.color));
    const offsets = gradient.stops.map((stop) => stop.offset);
    const mode = gradient.repeating ? CanvasKit.TileMode.Repeat : CanvasKit.TileMode.Clamp;
    // Interpolate in premultiplied space like CSS, so fades to transparent stay clean.
    const premul = 1;
    const point = (x, y) => [(x - view.x) * scale, (y - view.y) * scale];
    if (gradient.type === "linear") {
      return CanvasKit.Shader.MakeLinearGradient(
        point(gradient.x0, gradient.y0), point(gradient.x1, gradient.y1),
        colors, offsets, mode, null, premul,
      );
    }
    const [cx, cy] = point(gradient.cx, gradient.cy);
    const ellipse = CanvasKit.Matrix.multiply(
      CanvasKit.Matrix.translated(cx, cy),
      CanvasKit.Matrix.scaled(1, gradient.ry / gradient.rx),
      CanvasKit.Matrix.translated(-cx, -cy),
    );
    return CanvasKit.Shader.MakeRadialGradient([cx, cy], gradient.rx * scale, colors, offsets, mode, ellipse, premul);
  }

  // Overlays are placed in page coordinates (viewport position plus the
  // scroll offset when they were created), so they stay on their element.
  /**
   * A media control bar in CSS pixels at (x, y), relative to the tile: a
   * play/pause mark, "m:ss / m:ss" and a progress track that clicks seek
   * (see mediaBarLayout). Video draws it over the picture, audio as its box.
   */
  function drawMediaBar(canvas, x, y, width, height, resource, scale, overlay) {
    const paint = new CanvasKit.Paint();
    paint.setAntiAlias(true);
    const box = CanvasKit.XYWHRect(x * scale, y * scale, width * scale, height * scale);
    paint.setColor(overlay ? CanvasKit.Color(0, 0, 0, 0.65) : CanvasKit.Color(241, 243, 244, 1));
    if (overlay) canvas.drawRect(box, paint);
    else canvas.drawRRect(CanvasKit.RRectXY(box, height / 2 * scale, height / 2 * scale), paint);
    paint.setColor(overlay ? CanvasKit.Color(255, 255, 255, 1) : CanvasKit.Color(32, 33, 36, 1));
    const middle = (y + height / 2) * scale;
    const iconX = (x + 12) * scale;
    if (resource?.playing) {
      canvas.drawRect(CanvasKit.XYWHRect(iconX, middle - 6 * scale, 3.5 * scale, 12 * scale), paint);
      canvas.drawRect(CanvasKit.XYWHRect(iconX + 6.5 * scale, middle - 6 * scale, 3.5 * scale, 12 * scale), paint);
    } else {
      const path = CanvasKit.Path.MakeFromSVGString(
        `M ${iconX} ${middle - 7 * scale} L ${iconX + 11 * scale} ${middle} L ${iconX} ${middle + 7 * scale} Z`);
      if (path) { canvas.drawPath(path, paint); path.delete(); }
    }
    const layout = mediaBarLayout(width);
    const duration = resource?.duration;
    const time = Math.max(0, Math.min(Number.isFinite(duration) ? duration : Infinity, resource?.time ?? 0));
    if (layout.timeWidth) {
      const text = `${formatMediaTime(time)} / ${Number.isFinite(duration) ? formatMediaTime(duration) : "--:--"}`;
      const paragraph = makeParagraph(text, { color: overlay ? "rgba(255, 255, 255, 1)" : "rgba(32, 33, 36, 1)",
        fontFamily: ["sans-serif"], fontWeight: 400 }, 11, scale);
      paragraph.layout(layout.timeWidth * scale);
      canvas.drawParagraph(paragraph, (x + layout.timeStart) * scale, middle - paragraph.getHeight() / 2);
      paragraph.delete();
    }
    const trackStart = (x + layout.trackStart) * scale;
    const trackWidth = (layout.trackEnd - layout.trackStart) * scale;
    paint.setColor(overlay ? CanvasKit.Color(255, 255, 255, 0.35) : CanvasKit.Color(0, 0, 0, 0.18));
    canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(trackStart, middle - 2 * scale, trackWidth, 4 * scale), 2 * scale, 2 * scale), paint);
    if (Number.isFinite(duration) && duration > 0) {
      const played = trackWidth * time / duration;
      paint.setColor(overlay ? CanvasKit.Color(255, 255, 255, 1) : CanvasKit.Color(26, 115, 232, 1));
      canvas.drawRRect(CanvasKit.RRectXY(CanvasKit.XYWHRect(trackStart, middle - 2 * scale, played, 4 * scale), 2 * scale, 2 * scale), paint);
      canvas.drawCircle(trackStart + played, middle, 5 * scale, paint);
    }
    paint.delete();
  }

  function drawHints(canvas, region) {
    if (!page.hintsVisible) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(255, 238, 0, 1));
    for (const hint of page.hints) {
      const x = hint.x + hint.scrollX - region.x;
      const y = hint.y + hint.scrollY - region.y;
      canvas.drawRect(CanvasKit.XYWHRect(
        x * page.deviceScaleFactor,
        y * page.deviceScaleFactor,
        Math.max(18, hint.label.length * 10) * page.deviceScaleFactor,
        18 * page.deviceScaleFactor,
      ), paint);
      const builder = CanvasKit.ParagraphBuilder.MakeFromFontCollection(new CanvasKit.ParagraphStyle({
        textStyle: {
          color: CanvasKit.BLACK,
          fontFamilies,
          fontSize: 13 * page.deviceScaleFactor,
        },
        maxLines: 1,
      }), fontCollection);
      builder.addText(hint.label.toUpperCase());
      const paragraph = builder.build();
      builder.delete();
      paragraph.layout(30 * page.deviceScaleFactor);
      canvas.drawParagraph(
        paragraph,
        (x + 2) * page.deviceScaleFactor,
        y * page.deviceScaleFactor,
      );
      paragraph.delete();
    }
    paint.delete();
  }

  function replaceDocument(html, url, styleSheets = [], imageResources = emptyImageResources()) {
    replaceParsedDocument(parseHTMLDocument(html, url), styleSheets, imageResources);
  }

  /** `linkSheets` (link element -> { url, text }) makes the sheet list follow the DOM; without it the given sheets are fixed. */
  /** Marks a node whose own state changed (its subtree may restyle); null asks for a full restyle. */
  function markStyleDirty(node, features = [":state"]) {
    // Documents and fragments carry no state selectors read; their children's
    // changes arrive as mutation records.
    if (node?.nodeType === 9 || node?.nodeType === 11) return;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) styleChanges.full ||= node ? `touched ${node.nodeName}` : "unknown change";
    else {
      styleChanges.roots.add(element);
      const previous = styleChanges.rootFeatures.get(element);
      styleChanges.rootFeatures.set(element, previous ? [...new Set([...previous, ...features])] : features);
    }
  }

  function observeStyleChanges(document) {
    styleChanges.observer?.disconnect();
    styleChanges.records = [];
    styleChanges.roots = new Set();
    styleChanges.rootFeatures = new Map();
    styleChanges.full = "new document";
    styleChanges.activeElement = null;
    const observer = new page.window.MutationObserver((records) => { styleChanges.records.push(...records); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
    styleChanges.observer = observer;
  }

  /**
   * What the stylesheets' selectors make sensitive: sibling combinators let
   * a change restyle the following siblings; :has() lets one change the
   * match of an ancestor (or, with + and ~, of an earlier sibling), so the
   * compounds that contain it are re-checked there (`hasCompounds`).
   */
  function selectorTraitsFor(sheets) {
    if (selectorTraits.sheets === sheets) return selectorTraits;
    const parts = sheets.map(sheetTraitsFor);
    // Only the sheets in use stay cached.
    if (sheetTraitsCache.size > sheets.length) for (const sheet of new Set(sheetTraitsCache.keys()).difference(new Set(sheets))) sheetTraitsCache.delete(sheet);
    const union = (key) => new Set(parts.flatMap((part) => [...part[key]]));
    const any = (key) => parts.some((part) => part[key]);
    selectorTraits = {
      sheets, sibling: any("sibling"), hasSiblings: any("hasSiblings"),
      hasCompounds: [...union("hasCompounds")], structuralCompounds: [...union("structuralCompounds")],
      descendantFeatures: union("descendantFeatures"), siblingFeatures: union("siblingFeatures"),
      descendantStateCompounds: parts.flatMap((part) => part.descendantStateCompounds),
      siblingTargetCompounds: [...union("siblingTargetCompounds")],
      forward: any("forward"), firstChild: any("firstChild"), backward: any("backward"), lastChild: any("lastChild"),
      defined: any("defined"), target: any("target"),
    };
    // Checked against the old compounds this time, re-recorded after the restyle.
    hasStateStale = true;
    return selectorTraits;
  }

  /**
   * One sheet's share of `selectorTraitsFor`, cached by its text (sheets come
   * and go one at a time, and parsing all of them again is slow).
   */
  function sheetTraitsFor(sheet) {
    let traits = sheetTraitsCache.get(sheet);
    if (traits) return traits;
    traits = sheetTraits(sheet);
    sheetTraitsCache.set(sheet, traits);
    return traits;
  }

  /**
   * Which elements match each :has() and non-subject structural compound, as
   * of the last restyle. After an incremental round the kept maps are
   * current, so only compounds new to the sheets are looked up.
   */
  function recordHasState(traits) {
    const reuse = hasState !== null;
    if (compiledCompounds.size >= MAX_COMPILED_COMPOUNDS) compiledCompounds.clear();
    const record = (compounds, previous) => {
      const missing = compounds.filter((compound) => !(reuse && previous?.has(compound)));
      const matched = missing.length ? matchSelectors(page.document, missing, compiledCompounds) : null;
      const state = new Map();
      for (const compound of compounds) {
        if (reuse && previous?.has(compound)) state.set(compound, previous.get(compound));
        else if (matched.has(compound)) state.set(compound, matched.get(compound)); // invalid ones never match
      }
      return state;
    };
    hasState = record(traits.hasCompounds, hasState);
    structuralState = record(traits.structuralCompounds, structuralState);
    siblingState = record(traits.siblingTargetCompounds, siblingState);
  }

  /** Brings the recorded matches of an inserted subtree up to date (it may have been in the document before). */
  function recordInserted(root) {
    const states = [hasState, structuralState, siblingState].filter(Boolean);
    const now = matchSelectors(root, states.flatMap((state) => [...state.keys()]), compiledCompounds);
    for (const state of states) {
      for (const [compound, matched] of state) {
        const inside = now.get(compound);
        if (!inside) continue;
        for (const element of [root, ...root.getElementsByTagName("*")]) {
          if (inside.has(element)) matched.add(element); else matched.delete(element);
        }
      }
    }
  }


  /** element.matches(compound), with the compound compiled once (see matchSelectors). */
  function matchesCompound(element, compound) {
    let compiled = compiledCompounds.get(compound);
    if (compiled === undefined) {
      compiled = compileSelector(element, compound);
      if (compiled === undefined) return element.matches(compound);
      if (compiledCompounds.size >= MAX_COMPILED_COMPOUNDS) compiledCompounds.clear();
      compiledCompounds.set(compound, compiled);
    }
    return compiled !== null && matchesCompiled(element, compiled);
  }

  /** Re-checks `element` against recorded compounds; whether any match changed (the state is updated). */
  function matchesChanged(state, element) {
    let changed = false;
    for (const [compound, matched] of state ?? []) {
      let now = false;
      try { now = matchesCompound(element, compound); } catch {}
      if (now === matched.has(element)) continue;
      if (now) matched.add(element); else matched.delete(element);
      changed = true;
    }
    return changed;
  }

  /**
   * Elements whose :has() matches changed around a mutated node: its
   * ancestors (and their earlier siblings for :has(+ / ~)), re-checked
   * against the recorded state, which is updated as it goes.
   */
  function hasChanges(traits, node, add, checked) {
    if (!hasState || hasState.size === 0) return;
    for (let element = node?.nodeType === 1 ? node : node?.parentElement; element; element = element.parentElement) {
      // The records describe one final DOM, so each element is checked once a
      // round; its ancestors were too when it was.
      if (checked.has(element)) return;
      const candidates = [element];
      if (traits.hasSiblings) for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) candidates.push(sibling);
      for (const candidate of candidates) {
        if (candidate !== element && checked.has(candidate)) continue;
        checked.add(candidate);
        for (const [compound, matched] of hasState) {
          let now = false;
          try { now = matchesCompound(candidate, compound); } catch {}
          if (now === matched.has(candidate)) continue;
          if (now) matched.add(candidate); else matched.delete(candidate);
          add(candidate);
        }
      }
    }
  }

  /**
   * The style computation's dirty set, or null for a full restyle. Pending
   * mutation records become subtree roots: an attribute change restyles the
   * element's subtree (descendant selectors), a child list change its
   * parent's (structural pseudo-classes), with siblings included when the
   * sheets use sibling combinators; a change :has() may observe restyles all.
   */
  function takeStyleChanges(sheets) {
    const traits = selectorTraitsFor(sheets);
    const records = styleChanges.records;
    if (styleChanges.observer) records.push(...styleChanges.observer.takeRecords());
    const roots = styleChanges.roots;
    // Explicit roots mean that state-dependent selectors may need restyling;
    // they do not by themselves change render-tree content. DOM mutation
    // records below identify structural/content changes separately.
    let treeDirty = false;
    let full = styleChanges.full;
    const active = page.document.activeElement;
    if (active !== styleChanges.activeElement) {
      // :focus, :focus-within and :focus-visible follow the focused element.
      if (styleChanges.activeElement !== null) full ||= "focus moved";
      styleChanges.activeElement = active;
    }
    // Elements whose subtree restyles (`roots`), and elements whose own
    // matches may change but whose subtree restyles only if their style does
    // (`self`, decided by the style engine).
    const self = new Set();
    const add = (element) => roots.add(element);
    // Elements already re-checked this round against the :has(), sibling and structural state.
    const hasChecked = new Set();
    const siblingChecked = new Set();
    const structuralChecked = new Set();
    const inserted = new Set();
    // Siblings after a change: their own matches may differ; their subtrees
    // only when a non-subject compound right of + / ~ now matches differently.
    const laterSibling = (element) => {
      self.add(element);
      if (siblingChecked.has(element)) return;
      siblingChecked.add(element);
      if (matchesChanged(siblingState, element)) roots.add(element);
    };
    const later = (element) => { for (let next = element?.nextElementSibling; next; next = next.nextElementSibling) laterSibling(next); };
    const featureMatches = (used, changedFeatures) => changedFeatures.some((feature) => feature === ":state"
      ? [...used].some((candidate) => candidate.startsWith(":"))
      : used.has(feature));
    const stateAffectsDescendants = (element, changedFeatures) => {
      const states = changedFeatures.filter((feature) => feature.startsWith(":"));
      if (!states.length) return false;
      const available = new Set(elementFeatures(element));
      return traits.descendantStateCompounds.some((entry) => (states.includes(":state") || entry.states.some((state) => states.includes(state)))
        && entry.required.every((feature) => available.has(feature)));
    };
    /** An element whose features changed: itself, and wider where non-subject compounds use them. */
    const changed = (element, features) => {
      self.add(element);
      const ordinary = features.filter((feature) => !feature.startsWith(":"));
      if (featureMatches(traits.descendantFeatures, ordinary) || stateAffectsDescendants(element, features)) roots.add(element);
      if (traits.siblingFeatures.has("*") || featureMatches(traits.siblingFeatures, features)) later(element);
      hasChanges(traits, element, add, hasChecked);
    };
    const touchSibling = (element) => {
      self.add(element);
      if (structuralChecked.has(element)) return;
      structuralChecked.add(element);
      if (matchesChanged(structuralState, element)) roots.add(element);
    };
    if (!full && !hasState) full = "first restyle";
    // Marked elements: state outside the DOM (checked, value) or a DOM change
    // the records also describe; both start as a change of the element's state.
    for (const element of [...roots]) {
      roots.delete(element);
      if (!full) changed(element, styleChanges.rootFeatures.get(element) ?? [":state"]);
    }
    for (const record of records) {
      if (full) break;
      const target = record.target;
      if (record.type === "attributes") {
        if (target.nodeType !== 1) continue;
        const name = record.attributeName;
        // data/ARIA/title changes have no direct render-tree representation;
        // selectors that observe them are handled by the style diff below.
        // Other attributes may alter controls, replaced elements or visibility.
        if (!name.startsWith("data-") && !name.startsWith("aria-") && name !== "title") treeDirty = true;
        const features = ["[" + name];
        if (name === "class") {
          const before = new Set(String(record.oldValue ?? "").split(/\s+/).filter(Boolean));
          const after = new Set(target.classList);
          for (const value of before) if (!after.has(value)) features.push("." + value);
          for (const value of after) if (!before.has(value)) features.push("." + value);
        } else if (name === "id") {
          if (record.oldValue) features.push("#" + record.oldValue);
          const id = target.getAttribute("id");
          if (id) features.push("#" + id);
        }
        changed(target, features);
      } else if (record.type === "childList") {
        treeDirty = true;
        if (target.nodeType !== 1) { full = `children of ${target.nodeName}`; break; }
        // Inserted elements restyle; the parent itself may change (:empty);
        // siblings around the change point may match structural
        // pseudo-classes differently, and the ones after it sibling
        // combinators whose left side the inserted or removed nodes match.
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.parentElement === target) {
            add(node);
            inserted.add(node);
          }
        }
        self.add(target);
        hasChanges(traits, target, add, hasChecked);
        let next = record.nextSibling;
        while (next && next.nodeType !== 1) next = next.nextSibling;
        let previous = record.previousSibling;
        while (previous && previous.nodeType !== 1) previous = previous.previousSibling;
        if (next?.parentElement !== target) next = null;
        if (previous?.parentElement !== target) previous = null;
        if (traits.forward) for (let element = next; element; element = element.nextElementSibling) touchSibling(element);
        else if (traits.firstChild && next) touchSibling(next);
        if (traits.backward) for (let element = previous; element; element = element.previousElementSibling) touchSibling(element);
        else if (traits.lastChild && previous) touchSibling(previous);
        if (next && traits.siblingFeatures.size) {
          const moved = [...record.addedNodes, ...record.removedNodes, previous].filter((node) => node?.nodeType === 1);
          if (traits.siblingFeatures.has("*") || moved.some((node) => elementFeatures(node).some((feature) => traits.siblingFeatures.has(feature)))) {
            for (let element = next; element; element = element.nextElementSibling) laterSibling(element);
          }
        }
      } else if (record.type === "characterData") {
        treeDirty = true;
        // Only :empty and :has() can see text: the parent itself.
        const parent = target.parentElement;
        if (parent) {
          self.add(parent);
          hasChanges(traits, parent, add, hasChecked);
        }
      }
    }
    if (!full) for (const node of topmostConnected(inserted, page.document)) recordInserted(node);
    styleChanges.records = [];
    styleChanges.roots = new Set();
    styleChanges.rootFeatures = new Map();
    styleChanges.full = false;
    lastStyleReason = full || `${roots.size} root(s), ${self.size} self`;
    if (full) hasState = null; // recorded again after the full restyle
    return full ? null : { roots, self, treeDirty };
  }

  function replaceParsedDocument(parsed, styleSheets = [], imageResources = emptyImageResources(), linkSheets = null) {
    disposeFrames();
    closePiano();
    disposeVideos();
    page.realm?.dispose();
    page.realm = null;
    page.window?.happyDOM?.abort?.();
    for (const image of page.decodedImages) image.delete();
    disposeBackgrounds();
    page.window = parsed.window;
    page.document = parsed.document;
    observeStyleChanges(parsed.document);
    page.title = parsed.document.title;
    page.styleSheets = styleSheets;
    page.linkSheets = linkSheets;
    page.resources = imageResources.map;
    initializeVideos(parsed.document, page.resources);
    page.decodedImages = imageResources.decoded;
    page.imagesLoaded = null;
    imageRequests = new WeakMap();
    page.elementScroll = new Map();
    const timing = styleAndLayout();
    syncFrames();
    queueBackgroundImages();
    trace?.(`${page.url}: first style ${timing.style}ms, layout ${timing.layout}ms`);
    viewport.scrollTo(0, 0);
    setContentSize();
    page.hints = [];
    page.hintsVisible = false;
    page.needsPaint = true;
  }

  /** Style, render tree, layout and display list of the current document. */
  function styleAndLayout() {
    const started = hostPerformance.now();
    const ms = (from, to) => Math.round(to - from);
    const sheets = currentStyleSheets();
    const environment = { width: page.width, height: page.height, mobile };
    const changes = takeStyleChanges(sheets); // drained even when unused, so records do not pile up
    const taken = hostPerformance.now();
    // A rendering opportunity can be scheduled by lifecycle work which did
    // not actually change DOM, state, resources, or styles. Keep the retained
    // layout/display list in that case instead of laying the whole page out.
    if (page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets && changes
      && changes.roots.size === 0 && changes.self.size === 0) {
      lastStyleParts = `changes ${Math.round(taken - started)}, no invalidation`;
      return { style: Math.round(taken - started), layout: 0, skipped: true };
    }
    styleEngine.compute(page.document, sheets, environment, fullStyle ? null : changes?.roots ?? null, changes?.self ?? null);
    const computed = hostPerformance.now();
    if (!hasState || hasStateStale) {
      recordHasState(selectorTraitsFor(sheets));
      hasStateStale = false;
    }
    const recorded = hostPerformance.now();
    // Attribute mutations used by application bookkeeping often match no
    // different rule and do not alter render-tree content. Once style has
    // proved that no element changed, retain layout and paint unchanged.
    if (page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets && changes
      && !changes.treeDirty && styleEngine.incremental && styleEngine.restyled === 0) {
      lastStyleParts = `changes ${ms(started, taken)}, compute ${ms(taken, computed)}, record ${ms(computed, recorded)}, no visual change`;
      return { style: Math.round(recorded - started), layout: 0, skipped: true };
    }
    if (verifyStyle && styleEngine.incremental) verifyIncrementalStyle(sheets, environment);
    const verified = hostPerformance.now();
    page.backgroundColor = documentBackground(page.document, styleEngine);
    const nextRenderTree = renderTreeBuilder.build(page.document, styleEngine, page.resources);
    const styled = hostPerformance.now();
    lastStyleParts = `changes ${ms(started, taken)}, compute ${ms(taken, computed)}, record ${ms(computed, recorded)}, tree ${ms(verified, styled)}`;
    // MutationObserver also reports changes under non-rendered nodes such as
    // script and metadata elements. Compare the actual immutable layout input
    // after rebuilding it, so those changes do not trigger a full reflow.
    if (page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets
      && sameLayoutInput(page.renderTree.root, nextRenderTree.root, {
        ignoreResources: true,
        // A zero-element incremental pass retained every computed style.
        // Control placeholders may still wrap that style in a fresh object.
        ignoreStyles: styleEngine.incremental && styleEngine.restyled === 0,
      })) {
      lastStyleParts += ", unchanged layout input";
      return { style: Math.round(styled - started), layout: 0, skipped: true };
    }
    page.renderTree = nextRenderTree;
    page.layout = layoutEngine.layout(page.renderTree, {
      measureText, fontMetrics, width: page.width, viewportHeight: page.height, x: 0, y: 0,
    });
    page.displayList = paintList();
    // The content may now reach less far than a container was scrolled.
    if (clampElementScroll()) page.displayList = paintList();
    page.resourceLayoutDirty = false;
    laidOutSheets = sheets;
    setContentSize();
    return { style: Math.round(styled - started), layout: Math.round(hostPerformance.now() - styled) };
  }

  /** BUNINU_VERIFY_STYLE: compare an incremental restyle with a full one, element by element. */
  function verifyIncrementalStyle(sheets, environment) {
    const reference = new StyleEngine().compute(page.document, sheets, environment);
    const serialize = (style) => JSON.stringify(style, (key, value) => typeof value === "bigint" ? String(value) : value);
    let mismatches = 0;
    for (const element of page.document.querySelectorAll("*")) {
      const ours = serialize(styleEngine.get(element));
      const expected = serialize(reference.get(element));
      const pseudo = ["before", "after"].some((name) =>
        serialize(styleEngine.getPseudo(element, name)) !== serialize(reference.getPseudo(element, name)));
      if (ours === expected && !pseudo) continue;
      if (mismatches++ < 3) {
        const a = styleEngine.get(element);
        const b = reference.get(element);
        const fields = Object.keys(b).filter((key) => serialize(a[key]) !== serialize(b[key]));
        reportError(`buninu-browser: incremental style mismatch at <${element.localName} class="${element.getAttribute("class") ?? ""}">: ${pseudo ? "pseudo " : ""}${fields.join(", ")}`);
      }
    }
    if (mismatches) reportError(`buninu-browser: incremental style: ${mismatches} element(s) differ from a full restyle`);
  }

  /**
   * Brings style and layout up to date with the DOM. Whichever path asks (a
   * frame, or a script reading geometry or styles), the media and images the
   * DOM now names are requested first: a script that inserts images and
   * measures them at once must not leave them unloaded.
   */
  function rebuildRenderTree(reason = "update") {
    const started = hostPerformance.now();
    page.dirty = false;
    page.title = page.document?.title ?? page.title;
    let staleImages = [];
    if (page.document) {
      initializeVideos(page.document, page.resources);
      staleImages = queueImageResources();
    }
    const timing = styleAndLayout();
    for (const image of staleImages) {
      const index = page.decodedImages.indexOf(image);
      if (index >= 0) page.decodedImages.splice(index, 1);
      image.delete();
    }
    if (!timing.skipped) page.needsPaint = true;
    syncFrames();
    if (!timing.skipped) queueBackgroundImages();
    lastRebuildMs = hostPerformance.now() - started;
    trace?.(`${page.url}: restyle and relayout (${reason}) ${Math.round(lastRebuildMs)}ms`
      + ` (style ${timing.style}ms for ${styleEngine.incremental ? styleEngine.restyled : "all"} elements: ${lastStyleReason}; ${lastStyleParts}, layout ${timing.layout}ms)`);
  }

  // Each loadDocument starts a generation; stages of a superseded load stop.
  let loadGeneration = 0;
  let loaded = Promise.resolve();
  let imageRequests = new WeakMap();

  /**
   * Commits a document the controller fetched. `response` carries the body
   * text and metadata, or `error` when the network request failed. Resolves
   * with the load's generation at the first paint (a preview or the styled
   * page); the rest of the load continues, see `whenLoaded`.
   */
  function loadDocument(document) {
    const generation = ++loadGeneration;
    let commit;
    const committed = new Promise((resolve, reject) => {
      commit = { resolve: () => resolve(generation), reject };
    });
    page.loading = true;
    loaded = runLoad(document, generation, commit)
      .catch((error) => {
        commit.reject(error);
        if (generation === loadGeneration) reportError(error);
      })
      .finally(() => {
        commit.resolve();
        if (generation === loadGeneration) page.loading = false;
      });
    return committed;
  }

  async function runLoad({
    url, source = "", contentType = "text/html", status = 200, statusText = "", error = null, cookie = "",
  }, generation, commit) {
    const current = () => generation === loadGeneration;
    const finish = () => {
      page.loading = false;
      onLifecycle?.("DOMContentLoaded", generation);
      onLifecycle?.("load", generation);
    };
    page.url = url;
    page.cookie = typeof cookie === "string" ? cookie : "";
    if (error) {
      replaceDocument("", url);
      page.title = "Network error";
      page.document.body.textContent = error;
      rebuildRenderTree();
      render();
      commit.resolve();
      finish();
      return;
    }
    if (url === "about:blank") {
      replaceDocument("", url);
      // An iframe's blank document is scripted from its page (through
      // contentWindow and contentDocument), so it has a realm.
      if (embedded && page.scripting !== "off") {
        page.realm = createPageRealm({ window: page.window, document: page.document, mode: page.scripting, hooks: realmHooks(generation) });
        render();
        commit.resolve();
        // No scripts of its own: it is complete at once, and its realm reports so.
        await page.realm.runDocumentScripts();
        return;
      }
      render();
      commit.resolve();
      finish();
      return;
    }
    let phaseStart = hostPerformance.now();
    const phase = trace ? (name) => {
      const now = hostPerformance.now();
      trace(`${url}: ${name} ${Math.round(now - phaseStart)}ms`);
      phaseStart = now;
    } : () => {};
    const isHtml = contentType.toLowerCase().includes("html");
    const parsed = parseHTMLDocument(isHtml ? source : "<body></body>", url);
    phase("parse");
    // Stylesheets block rendering and scripts; images do not (only the
    // window load event waits for them, see whenImagesLoaded): one slow image
    // must not hold back the page's scripts. Images that are already here
    // when the styles are join the first paint; the rest are drawn as they come.
    const linkSheets = isHtml ? new WeakMap() : null;
    const styleSheets = isHtml ? loadStyleSheets(parsed.document, url, linkSheets) : Promise.resolve([]);
    const images = isHtml ? loadImageResources(parsed.document, url) : Promise.resolve(emptyImageResources());
    page.preloadedScripts = isHtml && page.scripting !== "off" ? preloadScripts(parsed.document, url) : new Map();
    let imagesReady = null;
    images.then((loaded) => { imagesReady = loaded; });
    let timer;
    let sheets = await Promise.race([
      styleSheets,
      new Promise((resolve) => (timer = hostSetTimeout(resolve, PREVIEW_DELAY_MS, null))),
    ]);
    hostClearTimeout(timer);
    if (!current()) return discard(images, parsed);
    if (!sheets) {
      // Stylesheets are slow: show the document with the user-agent
      // defaults and its inline <style> sheets meanwhile.
      replaceParsedDocument(parsed, inlineStyleSheets(parsed.document), emptyImageResources(), linkSheets);
      awaitImages(images, generation);
      render();
      phase("preview");
      commit.resolve();
      sheets = await styleSheets;
      if (!current()) return;
      phase(`${sheets.length} stylesheets`);
      // Same document, now styled; the scroll position is kept.
      page.styleSheets = sheets;
      rebuildRenderTree("stylesheets loaded");
    } else {
      phase(`${sheets.length} stylesheets${imagesReady ? ` and ${imagesReady.decoded.length} images` : ""}`);
      replaceParsedDocument(parsed, sheets, imagesReady ?? emptyImageResources(), linkSheets);
      if (!imagesReady) awaitImages(images, generation);
    }
    phase("style and layout");
    if (!isHtml) {
      page.document.body.textContent = source;
      rebuildRenderTree();
    }
    // An error status with a body shows that body, scripts included, as in
    // Chrome: sites serve real pages that way (Google's "unusual traffic"
    // check comes as 429). Only an empty response gets a note instead.
    if ((status < 200 || status > 299) && !source.trim()) {
      page.document.body.textContent = `HTTP ${status} ${statusText}`.trim();
      rebuildRenderTree();
    }
    render();
    phase("raster");
    commit.resolve();
    if (isHtml && page.scripting !== "off") {
      page.realm = createPageRealm({
        window: page.window,
        document: page.document,
        mode: page.scripting,
        hooks: realmHooks(generation),
      });
      await page.realm.runDocumentScripts();
      if (!current()) return;
      phase("scripts");
      page.loading = false;
      refresh();
      phase("style, layout and raster after scripts");
    } else {
      finish();
    }
  }

  /**
   * Like a browser's preload scanner: starts fetching the document's external
   * scripts and declared module preloads (<link rel=modulepreload>) as soon
   * as it is parsed, while its stylesheets load and it is styled, instead of
   * when the scripts' turn comes and a module graph is discovered level by
   * level. Only the bytes are fetched early; fetchScript() takes them.
   */
  function preloadScripts(document, documentUrl) {
    const preloaded = new Map();
    const preload = (href) => {
      let target;
      try { target = new URL(href, documentUrl); } catch { return; }
      if (!["http:", "https:"].includes(target.protocol) || preloaded.has(target.href)) return;
      const response = fetchResource(target.href, "script");
      response.catch(() => {}); // reported when the script runs
      preloaded.set(target.href, response);
    };
    for (const script of document.querySelectorAll("script[src]")) {
      const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
      if (type === "module" || (CLASSIC_SCRIPT_TYPES.has(type) && !script.hasAttribute("nomodule"))) preload(script.getAttribute("src"));
    }
    for (const link of document.querySelectorAll("link[rel~='modulepreload'][href]")) preload(link.getAttribute("href"));
    return preloaded;
  }

  /** Frees what a superseded load fetched. */
  async function discard(images, parsed = null) {
    parsed?.window?.happyDOM?.abort?.();
    const loaded = await images.catch(() => emptyImageResources());
    for (const image of loaded.decoded) image.delete();
  }

  /**
   * The document's initial images, still on their way: they are drawn when
   * they arrive (unless a script changed the src meanwhile), and the load
   * event waits for them.
   */
  function awaitImages(images, generation) {
    const document = page.document;
    // queueImageResources must not fetch these again.
    for (const element of document.querySelectorAll("img")) {
      const src = element.getAttribute("src");
      if (src) imageRequests.set(element, src);
    }
    page.imagesLoaded = images.then((loaded) => {
      if (generation !== loadGeneration || document !== page.document) {
        for (const image of loaded.decoded) image.delete();
        return;
      }
      for (const { element, src, resource } of loaded.entries) {
        if (element.getAttribute("src") !== src || page.resources.get(element)) {
          resource.image.delete();
          continue;
        }
        page.resources.set(element, resource);
        page.decodedImages.push(resource.image);
      }
      page.dirty = true;
      page.resourceLayoutDirty = true;
      scheduleFrame();
    }, () => {});
  }

  function inlineStyleSheets(document) {
    return [...document.querySelectorAll("style")]
      .filter((element) => !element.closest("noscript"))
      .map((element) => element.textContent ?? "");
  }

  /** Brings style, layout and raster up to date; returns whether it repainted. */
  function refresh() {
    if (page.dirty) rebuildRenderTree();
    if (!page.needsPaint) return false;
    render();
    return true;
  }

  function editFocusedText(text, backspace = false) {
    const element = page.document.activeElement;
    if (!element || !["INPUT", "TEXTAREA"].includes(element.tagName) || element.disabled || element.readOnly) return;
    if (element.tagName === "INPUT" && !["text", "search", "url", "email", "tel", "password"].includes(element.type)) return;
    // Mobile IMEs often send committed text without a usable keydown (key 229
    // or Unidentified). Handle that before the normal beforeinput insertion.
    if (!backspace && element.getAttribute("id") === "buninu-piano-input" && audio && text.length === 1) {
      const note = pianoNote(text);
      if (note !== null) {
        playPiano(note);
        return;
      }
    }
    const value = String(element.value ?? "");
    let start = Number.isInteger(element.selectionStart) ? element.selectionStart : value.length;
    const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start;
    if (backspace && start === end && start > 0) start = [...value.slice(0, start)].slice(0, -1).join("").length;
    if (backspace && start === end) return;
    if (page.realm) {
      const prevented = page.realm.dispatch(element, new page.window.InputEvent("beforeinput", {
        bubbles: true, cancelable: true, data: backspace ? null : text,
        inputType: backspace ? "deleteContentBackward" : "insertText",
      }));
      if (prevented) return;
    }
    element.value = value.slice(0, start) + text + value.slice(end);
    markStyleDirty(element); // :placeholder-shown, :valid / :invalid
    element.setSelectionRange?.(start + text.length, start + text.length);
    if (page.realm) page.realm.dispatch(element, new page.window.Event("input", { bubbles: true }));
    page.dirty = true;
  }

  let pianoStreamId = null;
  let pianoMixer = null;
  let pianoIdleTimer = null;
  const PIANO_IDLE_MS = 2000;

  function playPiano(note) {
    pianoMixer ??= new PianoMixer();
    pianoMixer.trigger(note);
    hostClearTimeout(pianoIdleTimer);
    pianoIdleTimer = hostSetTimeout(closePiano, PIANO_IDLE_MS);
    if (pianoStreamId !== null) return;
    const id = audio.open({ rate: 48000, channels: 1, name: "piano" }, (event) => {
      if (pianoStreamId !== id) return;
      if (event.event === "request") audio.write(id, pianoMixer.render(event.bytes));
      else if (event.event === "error" || event.event === "ended") {
        pianoStreamId = null;
        pianoMixer = null;
        if (event.event === "error") reportError(new Error(`piano audio: ${event.message}`));
      }
    });
    pianoStreamId = id;
  }

  function closePiano() {
    hostClearTimeout(pianoIdleTimer);
    pianoIdleTimer = null;
    if (pianoStreamId !== null) audio?.close(pianoStreamId);
    pianoStreamId = null;
    pianoMixer = null;
  }

  function realmHooks(generation) {
    return {
      frames: {
        self: ownWindow,
        parent: ownWindow.parent(),
        top: ownWindow.top(),
        childOf: (element) => ensureFrame(element)?.window ?? null,
      },
      definedChanged(name) {
        // An upgrade changes :defined for that tag's elements only.
        if (selectorTraits.defined) {
          for (const element of page.document.getElementsByTagName(String(name))) markStyleDirty(element, [":defined"]);
        }
        page.dirty = true;
        scheduleFrame();
      },
      touch(node = null, stateFeatures = []) {
        if (stateFeatures.length) markStyleDirty(node, stateFeatures);
        page.dirty = true;
        scheduleFrame();
      },
      mediaState,
      playMedia,
      pauseMedia,
      seekMedia,
      lifecycle(name) {
        if (generation !== loadGeneration) return;
        // The images load waited for are in the frame shown at load.
        if (name === "load") refresh();
        onLifecycle?.(name, generation);
        // Parsing and the deferred scripts are done: changes from async
        // scripts and late images get frames, without waiting for load.
        if (name === "DOMContentLoaded") {
          page.loading = false;
          scheduleFrame();
        }
      },
      whenImagesLoaded: () => Promise.all([page.imagesLoaded, ...[...page.backgrounds.values()].map((entry) => entry.loaded)]),
      afterTask() {},
      boundsOf(element) {
        if (page.dirty) rebuildRenderTree("script read geometry");
        return viewportBounds(element);
      },
      viewport: () => ({
        width: page.width,
        height: page.height,
        scrollX: viewport.x,
        scrollY: viewport.y,
        devicePixelRatio: page.deviceScaleFactor,
        pageScale: page.pageScale,
        mobile,
      }),
      scrollTo(x, y) {
        if (page.dirty) rebuildRenderTree("script scrolled");
        if (viewport.scrollTo(x, y)) render();
      },
      elementScroll(element) {
        if (page.dirty) rebuildRenderTree("script read geometry");
        return scrollerGeometry(element);
      },
      elementAt(x, y) {
        if (page.dirty) rebuildRenderTree("script read geometry");
        if (!(x >= 0 && y >= 0 && x < page.width && y < page.height) || !page.displayList) return null;
        return elementAtPoint(page.renderTree, page.displayList, x, y, viewport);
      },
      setElementScroll(element, x, y) {
        if (page.dirty) rebuildRenderTree("script scrolled");
        setElementScroll(element, x, y);
      },
      scrollIntoView(element) {
        if (page.dirty) rebuildRenderTree("script scrolled");
        revealElement(element);
      },
      computedStyle(element) {
        if (!element) return null;
        if (page.dirty) rebuildRenderTree("getComputedStyle");
        return styleEngine.get(element);
      },
      navigate: (url) => navigateTo(String(url)),
      activateLink(anchor) {
        const href = new URL(anchor.getAttribute("href"), page.url).href;
        const name = anchor.hasAttribute("download") ? anchor.getAttribute("download") ?? "" : null;
        if (href.startsWith("blob:") && name !== null) void downloadBlob(href, name);
        else navigateTo(href, name);
      },
      submitForm,
      async fetchScript(url) {
        if (/^(?:blob|data):/i.test(url)) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`script ${url} failed with HTTP ${response.status}`);
          return response.text();
        }
        const preloaded = page.preloadedScripts.get(url);
        if (preloaded) page.preloadedScripts.delete(url);
        const response = await (preloaded ?? fetchResource(url, "script"));
        if (!response.ok) throw new Error(`script ${url} failed with HTTP ${response.status}`);
        return new TextDecoder().decode(response.body);
      },
      reportError,
      consoleMessage,
      userAgent: () => page.userAgent,
      documentCookie: () => page.cookie,
      setDocumentCookie(value) {
        page.cookie = mergeDocumentCookie(page.cookie, String(value));
        setCookie(String(value));
      },
      webSockets,
      async pageFetch(request) {
        const response = await pageFetch(request);
        if (typeof response.documentCookie === "string") page.cookie = response.documentCookie;
        return response;
      },
    };
  }

  /**
   * Form submission (HTML §4.10.21.3): GET puts the entries in the action's
   * query; POST sends them as the body, encoded per the form's enctype, and
   * the controller navigates with that request.
   */
  function submitForm(form, submitter = null) {
    const method = (submitter?.getAttribute("formmethod") ?? form.getAttribute("method") ?? "get").toLowerCase();
    const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? page.url;
    const url = new URL(action || page.url, page.url);
    const entries = [...new page.window.FormData(form, submitter)];
    if (method === "post") {
      const enctype = (submitter?.getAttribute("formenctype") ?? form.getAttribute("enctype") ?? "").toLowerCase();
      requestNavigation(url.href, null, null, encodeFormBody(entries, enctype));
      return;
    }
    if (method !== "get") return;
    url.search = "";
    for (const [name, value] of entries) {
      if (typeof value === "string") url.searchParams.append(name, value);
    }
    navigateTo(url.href);
  }

  /** A POST form's entries as a request body and its content type. Files go as empty parts. */
  function encodeFormBody(entries, enctype) {
    const encoder = new TextEncoder();
    if (enctype === "multipart/form-data") {
      const boundary = `----buninuFormBoundary${crypto.randomUUID().replaceAll("-", "")}`;
      const quote = (text) => String(text).replace(/\r\n|\r|\n/g, "\r\n").replaceAll('"', "%22");
      let body = "";
      for (const [name, value] of entries) {
        const file = typeof value === "string" ? null : value;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"`
          + (file ? `; filename="${quote(file.name ?? "")}"\r\nContent-Type: application/octet-stream` : "")
          + `\r\n\r\n${file ? "" : String(value).replace(/\r\n|\r|\n/g, "\r\n")}\r\n`;
      }
      body += `--${boundary}--\r\n`;
      return { method: "POST", body: encoder.encode(body), contentType: `multipart/form-data; boundary=${boundary}` };
    }
    if (enctype === "text/plain") {
      const body = entries.map(([name, value]) => `${name}=${typeof value === "string" ? value : value.name ?? ""}\r\n`).join("");
      return { method: "POST", body: encoder.encode(body), contentType: "text/plain" };
    }
    const params = new URLSearchParams();
    for (const [name, value] of entries) params.append(name, typeof value === "string" ? value : value.name ?? "");
    return { method: "POST", body: encoder.encode(params.toString()), contentType: "application/x-www-form-urlencoded" };
  }

  /** The border box of an element's layout box in viewport coordinates. */
  function viewportBounds(element) {
    let fixed = false;
    for (let ancestor = element; ancestor && ancestor.nodeType === 1; ancestor = ancestor.parentElement) {
      if (styleEngine.get(ancestor)?.position === "fixed") { fixed = true; break; }
    }
    // Scroll containers around it move it too.
    const shift = scrollShift(element);
    const scrollX = (fixed ? 0 : viewport.x) + shift.x;
    const scrollY = (fixed ? 0 : viewport.y) + shift.y;
    let nodeId = null;
    for (const node of page.renderTree.nodesById.values()) {
      if (node.domNode === element && !node.pseudo) {
        nodeId = node.id;
        break;
      }
    }
    const box = nodeId == null ? null : page.layout.boxes.find((candidate) => candidate.nodeId === nodeId && !candidate.inline);
    if (box) return { left: box.x - scrollX, top: box.y - scrollY, width: box.width, height: box.height };
    const content = elementBounds(page.renderTree, page.layout, element);
    return content
      ? { left: content.left - scrollX, top: content.top - scrollY, width: content.width, height: content.height }
      : null;
  }

  /**
   * Navigation a page starts (a link, location.href = ...). A fragment of
   * the current document is navigated to at once, as HTML specifies, so the
   * page's own click and popstate handlers already see the new location;
   * the controller then only records the history entry (with the scroll
   * position being left). Anything else goes to the controller.
   */
  function navigateTo(url, downloadName = null) {
    const from = downloadName === null ? fragmentNavigation(url) : null;
    requestNavigation(url, downloadName, from);
  }

  /**
   * Navigates to `url` at once if it is a fragment of the current document;
   * returns the scroll offset it left, or null when it is not such a URL.
   */
  function fragmentNavigation(url) {
    const target = new URL(url, page.url);
    const current = new URL(page.url);
    target.hash = current.hash = "";
    if (!page.realm || !String(url).includes("#") || target.href !== current.href) return null;
    const from = { x: viewport.x, y: viewport.y };
    void showFragment(new URL(url, page.url).href);
    return from;
  }

  async function showFragment(url) {
    // :target moves from the old fragment's element to the new one's.
    if (selectorTraits.target) {
      for (const href of [page.url, url]) {
        let id = "";
        try { id = decodeURIComponent(new URL(href).hash.slice(1)); } catch {}
        const target = id && page.document.getElementById(id);
        if (target) markStyleDirty(target);
      }
    }
    page.url = url;
    scrollToFragment(url);
    // Pages that map fragments to their own targets scroll from popstate or hashchange listeners.
    await page.realm?.navigateToFragment(url);
    render();
  }

  /** Scrolls to the fragment's target (HTML §7.4.6.4). */
  function scrollToFragment(href) {
    const url = new URL(href);
    if (!url.hash || url.hash === "#") {
      viewport.scrollTo(0, 0);
      return;
    }
    let identifier;
    try {
      identifier = decodeURIComponent(url.hash.slice(1));
    } catch {
      identifier = url.hash.slice(1);
    }
    const target = page.document.getElementById(identifier)
      ?? [...page.document.getElementsByTagName("a")]
        .find((element) => element.getAttribute("name") === identifier);
    const bounds = target && elementBounds(page.renderTree, page.layout, target);
    if (bounds) viewport.scrollTo(viewport.x, bounds.top);
  }

  function collectHints() {
    const chars = ["a", "s", "d", "f", "j", "k", "l"];
    // Laid-out regions moved by the scroll containers around them, kept
    // where the element itself shows (not scrolled out of a container or covered).
    const regions = interactiveRegions(page.renderTree, page.layout, viewport, {})
      .map((region) => {
        const shift = scrollShift(region.element);
        if (!shift.x && !shift.y) return region;
        const rects = region.rects.map((rect) => ({
          ...rect, left: rect.left - shift.x, right: rect.right - shift.x, top: rect.top - shift.y, bottom: rect.bottom - shift.y,
        }));
        return { element: region.element, rects };
      })
      .filter((region) => {
        const rect = region.rects[0];
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        if (cx < 0 || cy < 0 || cx >= page.width || cy >= page.height) return false;
        const shown = page.displayList ? elementAtPoint(page.renderTree, page.displayList, cx, cy, viewport) : null;
        return !shown || shown === region.element || region.element.contains(shown) || shown.contains(region.element);
      })
      .slice(0, 49);
    const labels = regions.length <= chars.length
      ? chars
      : chars.flatMap((first) => chars.map((second) => first + second));
    page.hints = regions.map((region, index) => {
      const rect = region.rects[0];
      const id = String(index);
      region.element.setAttribute("data-casty-hint-id", id);
      return {
        id,
        label: labels[index],
        type: ["INPUT", "TEXTAREA", "SELECT"].includes(region.element.tagName) ? "focus" : "click",
        x: Math.round(Math.max(0, rect.left)),
        y: Math.round(Math.max(0, rect.top)),
        scrollX: viewport.x,
        scrollY: viewport.y,
        cx: Math.round((rect.left + rect.right) / 2),
        cy: Math.round((rect.top + rect.bottom) / 2),
        element: region.element,
      };
    });
    page.hintsVisible = true;
    render();
    return page.hints.map(({ element, scrollX, scrollY, ...hint }) => hint);
  }

  function clearHints() {
    for (const hint of page.hints) hint.element.removeAttribute("data-casty-hint-id");
    page.hints = [];
    page.hintsVisible = false;
    render();
  }

  async function downloadBlob(url, name) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`blob download failed: HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > 64 * 1024 * 1024) throw new Error("blob download exceeds 64 MB");
      requestDownload({ url, name, data });
    } catch (error) {
      reportError(error);
    }
  }

  const api = {
    loadDocument,
    /** Enables page scripts once the sandbox is ready: "ses", "host", or "off". */
    setScripting(mode) {
      page.scripting = ["ses", "host"].includes(mode) ? mode : "off";
    },
    setUserAgent(userAgent) {
      if (typeof userAgent === "string" && userAgent) page.userAgent = userAgent;
    },
    /** Messages the page logged, for diagnostics. */
    consoleMessages() {
      return page.realm?.console ?? [];
    },
    /** Same-document navigation: keep the document, move to the fragment. */
    showFragment,
    url() {
      return page.url;
    },
    scrollTo(x, y) {
      if (viewport.scrollTo(x, y)) render();
      return { x: viewport.x, y: viewport.y };
    },
    /**
     * `pageScale` is how much the client's viewport coordinates are scaled up
     * from the page's (--mobile on a wide viewport); pages read it as
     * visualViewport.scale.
     */
    resize(width, height, deviceScaleFactor = 1, pageScale = 1) {
      page.pageScale = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1;
      page.width = width;
      page.height = height;
      page.deviceScaleFactor = Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
        ? deviceScaleFactor
        : 1;
      viewport.resize(width, height);
      rebuildRenderTree();
      render();
    },
    screenshot() {
      refresh();
      return viewportPng();
    },
    /**
     * Diagnostics (not exposed over IPC): page-space border boxes and chosen
     * computed style fields of the elements matching `selector`.
     */
    inspect(selector, fields = ["display", "position", "width", "height"], limit = 20) {
      refresh();
      return [...(page.document?.querySelectorAll(selector) ?? [])].slice(0, limit).map((element) => {
        const bounds = viewportBounds(element);
        const style = styleEngine.get(element);
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
            element.getAttribute("class") ? `.${element.getAttribute("class").trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`,
          box: bounds && {
            x: Math.round(bounds.left + viewport.x), y: Math.round(bounds.top + viewport.y),
            width: Math.round(bounds.width), height: Math.round(bounds.height),
          },
          style: Object.fromEntries(fields.map((field) => [field, style[field]])),
        };
      });
    },
    /** Diagnostics: the element containing `text` and its ancestors, with boxes and style fields. */
    ancestry(text, fields = ["display", "width", "position"]) {
      refresh();
      const walker = page.document.createTreeWalker(page.document.body, 4);
      let node = walker.nextNode();
      while (node && !(node.data.includes(text) && node.parentElement && viewportBounds(node.parentElement))) node = walker.nextNode();
      const chain = [];
      for (let element = node?.parentElement; element && chain.length < 25; element = element.parentElement) {
        const bounds = viewportBounds(element);
        const style = styleEngine.get(element);
        chain.push({
          element: `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").split(/\s+/).slice(0, 2).join(".")}`,
          box: bounds && { x: Math.round(bounds.left + viewport.x), width: Math.round(bounds.width) },
          style: Object.fromEntries(fields.map((field) => [field, style[field]])),
        });
      }
      return chain;
    },
    /** Diagnostics (not exposed over IPC): display items whose text contains `text`. */
    displayItems(text) {
      refresh();
      return (page.displayList?.items ?? []).filter((item) => item.text?.includes(text));
    },
    /** Diagnostics: display items covering a page point, in paint order, with their elements. */
    itemsAt(x, y) {
      refresh();
      return (page.displayList?.items ?? []).map((item, index) => ({ index, item })).filter(({ item }) =>
        item.bounds.x <= x && x < item.bounds.x + item.bounds.width && item.bounds.y <= y && y < item.bounds.y + item.bounds.height)
        .map(({ index, item }) => {
          const node = page.renderTree?.nodesById.get(item.nodeId);
          const element = node?.domNode?.nodeType === 1 ? node.domNode : node?.domNode?.parentElement;
          return { index, op: item.op, color: item.color, text: item.text, bounds: item.bounds,
            element: element && `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").split(/\s+/).slice(0, 2).join(".")}` };
        });
    },
    /** Resolves once the current document has fired its load event (or was replaced). */
    async whenLoaded() {
      let pending;
      do {
        pending = loaded;
        await pending;
      } while (pending !== loaded);
    },
    /** The compositor scrolled: follow it, and rasterize around the new position when idle. */
    applyCompositorScroll(x, y) {
      viewport.scrollTo(x, y);
      syncedScroll = { x: viewport.x, y: viewport.y };
      schedulePrepaint();
    },
    title() {
      refresh();
      // Live value: scripts may have set document.title without touching layout.
      return page.document?.title || page.title;
    },
    scroll(deltaX, deltaY) {
      if (viewport.scrollBy(deltaX, deltaY)) render();
      return { x: viewport.x, y: viewport.y };
    },
    press(key, options = {}) {
      if (focusedFrame?.renderer) return focusedFrame.renderer.press(key, options);
      refresh();
      const pianoInput = page.document?.activeElement;
      if (audio && pianoInput?.getAttribute?.("id") === "buninu-piano-input") {
        const note = pianoNote(String(key), String(options.code ?? ""));
        if (note !== null && !options.repeat && !options.modifiers) {
          playPiano(note);
          return { x: viewport.x, y: viewport.y };
        }
      }
      // Pages see keydown/keyup first; preventDefault() cancels the default scroll.
      if (page.realm) {
        const target = page.document.activeElement ?? page.document.body;
        const modifiers = Number(options?.modifiers) || 0;
        const init = {
          key: String(key), code: String(options?.code ?? ""), repeat: Boolean(options?.repeat),
          altKey: Boolean(modifiers & 1), ctrlKey: Boolean(modifiers & 2),
          metaKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8),
          bubbles: true, cancelable: true,
        };
        const prevented = page.realm.dispatch(target, new page.window.KeyboardEvent("keydown", init));
        if (!prevented && !init.ctrlKey && !init.metaKey && !init.altKey) {
          if (key === "Backspace") editFocusedText("", true);
          else if (key === "Enter" && target.tagName === "TEXTAREA") {
            // A search IME's action key submits a search form. Other textareas
            // keep their normal newline behavior.
            const form = target.form;
            if (target.getAttribute("inputmode")?.toLowerCase() === "search" && form && form.checkValidity()) {
              const event = new page.window.SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: form });
              if (!page.realm.dispatch(form, event)) submitForm(form);
            } else editFocusedText("\n");
          }
          else if (String(key).length === 1) editFocusedText(String(key));
        }
        page.realm.dispatch(target, new page.window.KeyboardEvent("keyup", init));
        if (refresh() || prevented) return { x: viewport.x, y: viewport.y };
      }
      const pageStep = Math.max(31, viewport.height - 31);
      const delta = {
        ArrowUp: -31,
        ArrowDown: 31,
        PageUp: -pageStep,
        PageDown: pageStep,
        " ": pageStep,
      }[key];
      let changed = false;
      if (key === "Home") changed = viewport.scrollTo(viewport.x, 0);
      else if (key === "End") changed = viewport.scrollTo(viewport.x, viewport.contentHeight);
      else if (delta !== undefined) changed = viewport.scrollBy(0, delta);
      if (changed) render();
      return { x: viewport.x, y: viewport.y };
    },
    type(text) {
      if (focusedFrame?.renderer) return focusedFrame.renderer.type(text);
      editFocusedText(String(text ?? ""));
      refresh();
    },
    scrollOffset() {
      return { x: viewport.x, y: viewport.y };
    },
    /** The wheel at a viewport point: the delta the page itself still has to scroll (see wheel). */
    wheel(x, y, deltaX, deltaY, options = undefined) {
      return wheel(Number(x), Number(y), Number(deltaX) || 0, Number(deltaY) || 0, options);
    },
    /**
     * Clicks at a viewport point: the page receives a click event first, and
     * unless it calls preventDefault() a link under the point is returned for
     * the controller to navigate to.
     */
    click(x, y) {
      refresh();
      // Activation can toggle checked state (radios in a group, through a
      // label) without a DOM mutation, so the next restyle is a full one.
      markStyleDirty(null); // full: click
      let region = hitTest(page.renderTree, page.layout, x, y, viewport, viewport);
      let forwarded = false;
      if (!region) {
        // Some search forms draw a wide control around a narrow textarea and
        // rely on script to forward clicks. Preserve that affordance when the
        // form has exactly one search field, even if its script did not run.
        for (const form of page.document.querySelectorAll('form[role="search"]')) {
          const bounds = viewportBounds(form);
          if (!bounds || x < bounds.left || x >= bounds.left + bounds.width
            || y < bounds.top || y >= bounds.top + bounds.height) continue;
          const fields = form.querySelectorAll('textarea[inputmode="search"], input[type="search"]');
          if (fields.length === 1) {
            region = { element: fields[0] };
            forwarded = true;
          }
          break;
        }
      }
      // Pointer events go to the topmost element painted at the point, where
      // it is now (scroll containers move their content); the interactive
      // regions (laid out, unscrolled) stand in only where nothing is painted,
      // and a search form's forwarded field takes the click on the form.
      const precise = page.displayList ? elementAtPoint(page.renderTree, page.displayList, x, y, viewport) : null;
      const target = forwarded ? region.element : precise ?? region?.element ?? null;
      if (!target) {
        focusedFrame = null;
        return null;
      }
      // A click inside an iframe belongs to its document alone.
      const inFrame = target.tagName === "IFRAME" ? frameAt(target, x, y) : null;
      focusedFrame = inFrame?.frame ?? null;
      if (inFrame) {
        const followed = inFrame.frame.renderer.click(inFrame.x, inFrame.y);
        const href = typeof followed === "string" ? followed : followed?.fragmentFrom ? null : followed?.url;
        if (href && !followed?.download) void loadFrame(inFrame.frame, href);
        return null;
      }
      if (page.url === "about:audio") {
        const key = target.closest?.("[data-piano-note]");
        const note = Number(key?.getAttribute("data-piano-note"));
        if (key && Number.isInteger(note) && note >= 0 && note <= 127 && audio) {
          playPiano(note);
          page.document.getElementById("buninu-piano-input")?.focus();
          return null;
        }
      }
      // The press focuses the focusable element it lands in, unless mousedown was canceled.
      const focus = () => {
        const focusable = target.closest?.("input, textarea, select, button, [tabindex]");
        if (focusable && !focusable.disabled) focusable.focus();
      };
      if (!page.realm) focus();
      else {
        // A press and release, then the click (UI Events §3.5).
        const init = { bubbles: true, cancelable: true, composed: true, clientX: Number(x), clientY: Number(y), button: 0 };
        const PointerEvent = page.window.PointerEvent ?? page.window.MouseEvent;
        const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
        page.realm.dispatch(target, new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
        if (!page.realm.dispatch(target, new page.window.MouseEvent("mousedown", { ...init, buttons: 1 }))) focus();
        page.realm.dispatch(target, new PointerEvent("pointerup", pointer));
        page.realm.dispatch(target, new page.window.MouseEvent("mouseup", init));
        const prevented = page.realm.dispatch(target, new page.window.MouseEvent("click", { ...init, detail: 1 }));
        refresh();
        if (prevented) return null;
      }
      if (target.tagName === "AUDIO" || target.tagName === "VIDEO") {
        clickMedia(target, x, y);
        return null;
      }
      const anchor = target.closest?.("a[href]");
      if (!anchor) return null;
      const href = new URL(anchor.getAttribute("href"), page.url).href;
      if (href.startsWith("javascript:")) {
        this.runJavaScriptURL(href);
        return null;
      }
      if (href.startsWith("blob:") && anchor.hasAttribute("download")) {
        void downloadBlob(href, anchor.getAttribute("download") ?? "");
        return null;
      }
      if (anchor.hasAttribute("download")) return { url: href, download: anchor.getAttribute("download") ?? "" };
      const fragmentFrom = fragmentNavigation(href);
      return fragmentFrom ? { url: href, fragmentFrom } : href;
    },
    /**
     * Navigating to a javascript: URL runs its percent-decoded source as a
     * classic script in the current document (HTML §7.4.2.3.4); the page
     * stays. Nothing runs when scripting is off.
     */
    runJavaScriptURL(url) {
      if (!page.realm || !/^javascript:/i.test(String(url))) return;
      let source = String(url).slice("javascript:".length);
      try {
        source = decodeURIComponent(source);
      } catch {}
      page.realm.run(source);
      refresh();
    },
    async evaluate(expression) {
      const source = expression.trim();
      const utilityExpression = source.match(
        /^\(async\(\)=>\{return await \((.*)\)\}\)\(\)$/s,
      )?.[1]?.trim() ?? source;
      if (source.includes("const CLICKABLE") && source.includes("data-casty-hint-id")) {
        return JSON.stringify(collectHints());
      }
      if (source.includes("hint target disappeared")) {
        const id = source.match(/data-casty-hint-id=\"(\d+)\"/)?.[1];
        const hint = page.hints.find((item) => item.id === id);
        return hint ? { x: hint.cx, y: hint.cy } : null;
      }
      if (source.includes("const overlay") && source.includes("removeAttribute('data-casty-hint-id')")) {
        clearHints();
        return undefined;
      }
      if (source.includes("__casty_hints") && source.includes("old.remove()")) {
        page.hintsVisible = false;
        render();
        return undefined;
      }
      if (source.includes("const el = document.getElementById('__casty_hints')")) {
        page.hintsVisible = false;
        render();
        return undefined;
      }
      if (source.includes("label.startsWith(")) return undefined;
      if (/^(?:\(\)\s*=>\s*)?document\.title$/.test(utilityExpression)) {
        return page.document?.title ?? "";
      }
      if (/^(?:\(\)\s*=>\s*)?document\.body\.textContent$/.test(utilityExpression)) {
        return page.document?.body?.textContent ?? "";
      }
      if (/^(?:\(\)\s*=>\s*)?document\.body\.innerText$/.test(utilityExpression)) {
        return renderTreeText(page.renderTree);
      }
      if (/^(?:\(\)\s*=>\s*)?document\.documentElement\.outerHTML$/.test(utilityExpression)) {
        return page.document?.documentElement?.outerHTML ?? "";
      }
      if (/^(?:\(\)\s*=>\s*)?(?:window\.)?scrollX$/.test(utilityExpression)) return viewport.x;
      if (/^(?:\(\)\s*=>\s*)?(?:window\.)?scrollY$/.test(utilityExpression)) return viewport.y;
      // Anything else is page script; only structured-clone-safe results leave the renderer.
      if (!page.realm) return undefined;
      let value = page.realm.evaluate(utilityExpression);
      if (value !== null && typeof value === "object" && typeof value.then === "function") {
        value = await Promise.race([
          Promise.resolve(value),
          new Promise((resolve) => hostSetTimeout(resolve, 5000, undefined)),
        ]).catch((error) => String(error?.message ?? error));
      }
      refresh();
      return cloneableResult(value);
    },
    dispose() {
      disposedRenderer = true;
      hostClearTimeout(prepaintTimer);
      hostClearTimeout(frameTimer);
      disposeFrames();
      page.realm?.dispose();
      closePiano();
      disposeVideos();
      page.window?.happyDOM?.abort?.();
      for (const image of page.decodedImages) image.delete();
      disposeBackgrounds();
    },
  };

  replaceDocument("", "about:blank");
  render();
  return api;

  /** Fetches the document's linked stylesheets (in parallel), then lists all its sheets. */
  async function loadStyleSheets(document, documentUrl, linkSheets) {
    const pending = [];
    collectStyleSheets(document, documentUrl, linkSheets, pending);
    await Promise.all(pending);
    return collectStyleSheets(document, documentUrl, linkSheets);
  }

  /**
   * The document's style sheets as they are now, in document order: each
   * <style>'s current text and each loaded <link rel=stylesheet>. Sheets that
   * scripts add later count too; a link not fetched yet is requested (its
   * promise goes to `pending`) and redraws the page when it arrives.
   */
  function collectStyleSheets(document, documentUrl, linkSheets, pending = null) {
    const sheets = [];
    for (const element of document.querySelectorAll("style, link[rel~='stylesheet']")) {
      if (element.closest("noscript")) continue;
      if (element.tagName === "STYLE") {
        sheets.push(element.textContent ?? "");
        continue;
      }
      const href = element.getAttribute("href");
      let url;
      try { url = href ? new URL(href, documentUrl).href : null; } catch { url = null; }
      if (!url) continue;
      const loaded = linkSheets.get(element);
      if (loaded?.url === url) {
        if (loaded.text !== null) sheets.push(loaded.text);
        continue;
      }
      const entry = { url, text: null };
      linkSheets.set(element, entry);
      const request = fetchResource(url, "stylesheet").then((response) => {
        // Its url()s are relative to the sheet, not to the document.
        if (response.ok) entry.text = absolutizeStyleSheetUrls(new TextDecoder().decode(response.body), response.url || url);
      }, () => {
        // A failed stylesheet must not prevent the document itself from loading.
      }).then(() => {
        if (entry.text === null || document !== page.document || linkSheets.get(element) !== entry) return;
        page.dirty = true;
        scheduleFrame();
      });
      pending?.push(request);
    }
    return sheets;
  }

  /** The current sheet list, the same array while nothing changed (the style engine caches parsed rules by it). */
  function currentStyleSheets() {
    if (!page.linkSheets) return page.styleSheets;
    const sheets = collectStyleSheets(page.document, page.url, page.linkSheets);
    const previous = page.styleSheets;
    if (previous.length === sheets.length && sheets.every((sheet, index) => sheet === previous[index])) return previous;
    return page.styleSheets = sheets;
  }

  async function loadImageResources(document, documentUrl) {
    const map = new WeakMap();
    const decoded = [];
    const entries = [];
    await Promise.all([...document.querySelectorAll("img")].map(async (element) => {
      const src = element.getAttribute("src");
      if (!src) return;
      try {
        const response = await fetchResource(new URL(src, documentUrl).href, "image");
        if (!response.ok) return;
        // Untrusted image bytes are decoded here, inside the renderer.
        const bytes = response.body;
        const { width, height } = await new Bun.Image(bytes).metadata();
        const image = CanvasKit.MakeImageFromEncoded(bytes);
        if (!image) return;
        const resource = Object.freeze({ width, height, image, url: response.url });
        map.set(element, resource);
        decoded.push(image);
        entries.push({ element, src, resource });
      } catch {
        // Broken images keep their fallback replaced-element dimensions.
      }
    }));
    return { map, decoded, entries };
  }

  // ---- iframes. Each same-origin iframe's document lives in a page renderer
  // of its own (embedded), sharing this process's CanvasKit: its frames are
  // cut to its viewport and drawn into the iframe's box through a resource
  // whose image is swapped as frames arrive. Other documents are not given to
  // this process (the controller checks), so their iframes stay empty.

  /** Brings the frames in line with the document's iframes: their documents and sizes. */
  function syncFrames() {
    const document = page.document;
    const elements = document ? [...document.getElementsByTagName("iframe")] : [];
    if (!elements.length && !frames.size) return;
    const boxes = frameBoxes();
    for (const [element, frame] of frames) {
      if (!element.isConnected || element.ownerDocument !== document) disposeFrame(frame);
    }
    for (const element of elements) {
      const frame = ensureFrame(element);
      page.resources.set(element, frame.holder);
      // Setting the name attribute names the frame (HTML §4.8.5).
      const nameAttribute = element.getAttribute("name");
      if (nameAttribute !== frame.nameAttribute) {
        frame.nameAttribute = nameAttribute;
        frame.window.setName(nameAttribute ?? "");
      }
      frame.box = boxes.get(element) ?? null;
      const width = Math.max(1, Math.round(frame.box?.width ?? 300));
      const height = Math.max(1, Math.round(frame.box?.height ?? 150));
      if (!frame.size || frame.size.width !== width || frame.size.height !== height || frame.size.scale !== page.deviceScaleFactor) {
        frame.size = { width, height, scale: page.deviceScaleFactor };
        void frame.ready.then((renderer) => renderer?.resize(width, height, page.deviceScaleFactor));
      }
      const source = frameSource(element);
      if (source !== frame.source) {
        frame.source = source;
        void loadFrame(frame, source);
      }
    }
  }

  /** The frame of an iframe of this document, made on first need (a script may post to it at once). */
  function ensureFrame(element) {
    let frame = frames.get(element);
    if (frame) return frame;
    if (element?.tagName !== "IFRAME" || !element.isConnected || element.ownerDocument !== page.document) return null;
    frame = { element, renderer: null, ready: null, source: undefined, token: 0, size: null, box: null,
      window: windowHandle(ownWindow, element.getAttribute("name") ?? ""), holder: { width: 0, height: 0, image: null } };
    frame.nameAttribute = element.getAttribute("name");
    frames.set(element, frame);
    page.resources.set(element, frame.holder);
    // Made at once, as is its initial about:blank document (HTML §4.8.5): a
    // script can use its contentWindow as soon as the iframe is inserted.
    const renderer = buildPageRenderer({
      fetchResource: rawFetchResource,
      requestNavigation: (url, downloadName) => {
        if (downloadName === null) void loadFrame(frame, url);
      },
      requestDownload,
      reportError,
      pageFetch,
      webSockets,
      setCookie,
      consoleMessage,
      onFrame: (update) => showFrame(frame, update),
      onLifecycle: (name, generation) => frameLifecycle(frame, name, generation),
      videoDecoder,
      mobile,
      embedded: true,
      frameWindow: frame.window,
    }, loadedGraphics);
    // Page scripts in "host" mode share one global object; a frame's scripts need their own.
    renderer.setScripting(page.scripting === "ses" ? "ses" : "off");
    renderer.setUserAgent(page.userAgent);
    frame.renderer = renderer;
    frame.ready = Promise.resolve(renderer);
    frame.loading = renderer.loadDocument({ url: "about:blank" }).then((generation) => {
      frame.generation = generation;
      frame.initialGeneration = generation;
    });
    // Then its src, at once: syncFrames only adjusts the size later. A frame
    // without one keeps its initial document, whose load the iframe fires;
    // otherwise only its src's load is fired.
    frame.source = frameSource(element);
    frame.silentInitialLoad = frame.source !== "about:blank";
    if (frame.source !== "about:blank") void loadFrame(frame, frame.source);
    return frame;
  }

  /** Each rendered iframe's content box, in document coordinates. */
  function frameBoxes() {
    const boxes = new Map();
    if (!page.layout || !page.renderTree) return boxes;
    for (const fragment of page.layout.fragments) {
      for (const run of fragment.runs) {
        if (run.type !== "image") continue;
        const element = page.renderTree.nodesById.get(run.nodeId)?.domNode;
        if (element?.tagName === "IFRAME") {
          boxes.set(element, { x: run.x, y: run.y ?? fragment.y, width: run.width, height: run.height });
        }
      }
    }
    return boxes;
  }

  /** The URL an iframe shows: its src resolved against the page, or about:blank. */
  function frameSource(element) {
    const src = element.getAttribute("src")?.trim();
    if (!src) return "about:blank";
    try {
      return new URL(src, page.url).href;
    } catch {
      return "about:blank";
    }
  }

  /** Loads a frame's document; a cross-origin one (or a failure) leaves it blank. */
  async function loadFrame(frame, url) {
    const token = ++frame.token;
    let document = { url: "about:blank" };
    let target = null;
    try { target = new URL(url); } catch { /* blank */ }
    if (target && ["http:", "https:"].includes(target.protocol) && target.origin === new URL(page.url).origin) {
      try {
        const response = await fetchResource(target.href, "iframe");
        document = {
          url: response.url || target.href,
          source: new TextDecoder().decode(response.body),
          contentType: response.contentType || "text/html",
          status: response.status,
          statusText: response.statusText ?? "",
          cookie: response.documentCookie ?? page.cookie,
        };
      } catch (error) {
        trace?.(`${page.url}: iframe ${target.href} not shown: ${error?.message ?? error}`);
      }
    }
    const renderer = await frame.ready;
    if (!renderer || token !== frame.token || !frames.has(frame.element)) return;
    frame.loading = renderer.loadDocument(document).then((generation) => { frame.generation = generation; });
  }

  /** A frame's document painted: its viewport becomes the iframe's image. */
  function showFrame(frame, { tile, scroll, viewport: size }) {
    if (!frames.has(frame.element)) return;
    const { pixels, width, height } = cropViewport(tile, scroll.x, scroll.y, size.width, size.height);
    const image = CanvasKit.MakeImage({
      width, height, alphaType: CanvasKit.AlphaType.Unpremul, colorType: CanvasKit.ColorType.RGBA_8888,
      colorSpace: CanvasKit.ColorSpace.SRGB,
    }, pixels, width * 4);
    if (!image) return;
    const first = !frame.holder.image;
    frame.holder.image?.delete();
    Object.assign(frame.holder, { width, height, image });
    framesVersion++;
    // The display list leaves out images that have nothing to show yet.
    if (first && page.layout) page.displayList = paintList();
    page.needsPaint = true;
    if (!framePaintTimer) {
      framePaintTimer = hostSetTimeout(() => {
        framePaintTimer = null;
        if (page.needsPaint && !page.loading) render();
      }, 16);
    }
  }

  /** A frame's document reached DOMContentLoaded or load: the iframe fires load. */
  function frameLifecycle(frame, name, generation) {
    if (name !== "load" || !frames.has(frame.element)) return;
    // A blank document loads within loadDocument, before its generation is known here.
    hostSetTimeout(() => void frame.loading?.then(() => {
      if (frame.generation !== generation || !frames.has(frame.element) || !page.realm) return;
      if (frame.silentInitialLoad && generation === frame.initialGeneration) return;
      page.realm.dispatch(frame.element, new page.window.Event("load"));
      refresh();
    }), 0);
  }

  function disposeFrame(frame) {
    frames.delete(frame.element);
    if (focusedFrame === frame) focusedFrame = null;
    frame.token++;
    void frame.ready?.then((renderer) => renderer?.dispose());
    frame.holder.image?.delete();
    frame.holder.image = null;
  }

  function disposeFrames() {
    for (const frame of [...frames.values()]) disposeFrame(frame);
    hostClearTimeout(framePaintTimer);
    framePaintTimer = null;
  }

  /** The frame under a viewport point, with the point in the frame's own viewport. */
  function frameAt(element, x, y) {
    const frame = frames.get(element);
    if (!frame?.renderer || !frame.box) return null;
    const shift = scrollShift(element);
    return { frame, x: x + viewport.x + shift.x - frame.box.x, y: y + viewport.y + shift.y - frame.box.y };
  }

  // ---- Scroll containers (CSS Overflow 3 §3). Elements with overflow other
  // than visible or clip scroll their content: the offsets live here, paint
  // moves the content by them (see paintEffects), and the wheel, scripts and
  // scrollIntoView change them.

  /** The page scrolls over its laid-out size and whatever overflows it (see displayList.extent). */
  function setContentSize() {
    const extent = page.displayList?.extent;
    viewport.setContentSize(Math.max(page.layout.width, extent?.width ?? 0), Math.max(page.layout.height, extent?.height ?? 0));
  }

  function paintList() {
    return buildDisplayList(page.layout, page.renderTree, page.resources, backgroundResource, scrollOffsetOf);
  }

  function scrollOffsetOf(element) {
    return element ? page.elementScroll.get(element) ?? null : null;
  }

  /** The render node and layout box of an element, or null. */
  function layoutBoxOf(element) {
    if (!page.renderTree || !page.layout) return null;
    for (const node of page.renderTree.nodesById.values()) {
      if (node.domNode !== element || node.pseudo) continue;
      const box = page.layout.boxes.find((candidate) => candidate.nodeId === node.id && !candidate.inline);
      return box ? { node, box } : null;
    }
    return null;
  }

  /**
   * A scroll container's scroll position and sizes (CSSOM View §6): its
   * padding box is the client area, its content's reach the scroll area.
   * Null for an element that is not one.
   */
  function scrollerGeometry(element) {
    const style = element?.nodeType === 1 ? styleEngine.get(element) : null;
    if (!style?.overflowScrollX && !style?.overflowScrollY) return null;
    const found = layoutBoxOf(element);
    if (!found) return null;
    const { node, box } = found;
    const [borderTop, borderRight, borderBottom, borderLeft] = style.borderWidths ?? [0, 0, 0, 0];
    const padding = style.padding ?? [0, 0, 0, 0];
    const client = {
      x: box.x + borderLeft,
      y: box.y + borderTop,
      width: Math.max(0, box.width - borderLeft - borderRight),
      height: Math.max(0, box.height - borderTop - borderBottom),
    };
    const extent = page.displayList?.scrollers?.get(node.id);
    const scrollWidth = Math.max(client.width, extent ? extent.right - client.x + (Number(padding[1]) || 0) : 0);
    const scrollHeight = Math.max(client.height, extent ? extent.bottom - client.y + (Number(padding[2]) || 0) : 0);
    const offset = page.elementScroll.get(element) ?? { x: 0, y: 0 };
    return {
      x: offset.x,
      y: offset.y,
      clientWidth: client.width,
      clientHeight: client.height,
      scrollWidth,
      scrollHeight,
      maxX: style.overflowScrollX ? Math.max(0, scrollWidth - client.width) : 0,
      maxY: style.overflowScrollY ? Math.max(0, scrollHeight - client.height) : 0,
      user: { x: style.overflowScrollX === "auto", y: style.overflowScrollY === "auto" },
    };
  }

  /** Scrolls a scroll container to (x, y), clamped; returns whether it moved. */
  function setElementScroll(element, x, y) {
    const geometry = scrollerGeometry(element);
    if (!geometry) return false;
    const next = {
      x: Math.round(Math.min(geometry.maxX, Math.max(0, Number(x) || 0))),
      y: Math.round(Math.min(geometry.maxY, Math.max(0, Number(y) || 0))),
    };
    if (next.x === geometry.x && next.y === geometry.y) return false;
    if (next.x || next.y) page.elementScroll.set(element, next);
    else page.elementScroll.delete(element);
    page.displayList = paintList();
    page.needsPaint = true;
    // A scroll event at the element, as a task (CSSOM View §13.1).
    hostSetTimeout(() => {
      if (page.realm && element.isConnected) page.realm.dispatch(element, new page.window.Event("scroll"));
    }, 0);
    return true;
  }

  /**
   * Keeps offsets within what each scroll container can scroll after a
   * relayout (measured on the display list just built); returns whether any changed.
   */
  function clampElementScroll() {
    let changed = false;
    for (const [element, offset] of page.elementScroll) {
      const geometry = element.isConnected ? scrollerGeometry(element) : null;
      if (!geometry) {
        page.elementScroll.delete(element);
        changed = true;
      } else if (offset.x > geometry.maxX || offset.y > geometry.maxY) {
        page.elementScroll.set(element, { x: Math.min(offset.x, geometry.maxX), y: Math.min(offset.y, geometry.maxY) });
        changed = true;
      }
    }
    return changed;
  }

  /** How far the scroll containers around an element have moved it (to subtract from its layout position). */
  function scrollShift(element) {
    let x = 0;
    let y = 0;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node !== element) {
        const offset = page.elementScroll.get(node);
        if (offset) {
          x += offset.x;
          y += offset.y;
        }
      }
      // Fixed content does not move with what is around it.
      if (styleEngine.get(node)?.position === "fixed") break;
    }
    return { x, y };
  }

  /**
   * The wheel at a viewport point (UI Events §5.4): a wheel event at the
   * element there; unless it is canceled, the scroll containers from there
   * outwards each take what they can still scroll of the delta and pass the
   * rest on (scroll chaining), an iframe's document included unless the
   * iframe says scrolling="no". Returns the delta left over for the page,
   * which the compositor scrolls (or, for an iframe's document, the frame here).
   */
  function wheel(x, y, deltaX, deltaY, { scrollViewport = true } = {}) {
    refresh();
    let left = { x: deltaX, y: deltaY };
    const target = page.displayList ? elementAtPoint(page.renderTree, page.displayList, x, y, viewport) : null;
    if (target?.tagName === "IFRAME") {
      const inFrame = frameAt(target, x, y);
      if (inFrame) {
        left = inFrame.frame.renderer.wheel(inFrame.x, inFrame.y, left.x, left.y, {
          scrollViewport: target.getAttribute("scrolling")?.toLowerCase() !== "no",
        });
        if (!left.x && !left.y) return left;
      }
    }
    if (target && page.realm) {
      const WheelEvent = page.window.WheelEvent ?? page.window.MouseEvent;
      const event = new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX: left.x, deltaY: left.y, deltaMode: 0,
      });
      if (page.realm.dispatch(target, event)) return { x: 0, y: 0 };
    }
    let moved = false;
    for (let node = target; node && node.nodeType === 1 && (left.x || left.y); node = node.parentElement) {
      const geometry = scrollerGeometry(node);
      if (!geometry) continue;
      const nextX = geometry.user.x ? Math.min(geometry.maxX, Math.max(0, geometry.x + left.x)) : geometry.x;
      const nextY = geometry.user.y ? Math.min(geometry.maxY, Math.max(0, geometry.y + left.y)) : geometry.y;
      if (nextX === geometry.x && nextY === geometry.y) continue;
      setElementScroll(node, nextX, nextY);
      left = { x: left.x - (nextX - geometry.x), y: left.y - (nextY - geometry.y) };
      moved = true;
    }
    // An iframe's document scrolls its own viewport; the top-level page leaves that to the compositor.
    if (embedded && scrollViewport && (left.x || left.y)) {
      const before = { x: viewport.x, y: viewport.y };
      if (viewport.scrollBy(left.x, left.y)) {
        left = { x: left.x - (viewport.x - before.x), y: left.y - (viewport.y - before.y) };
        moved = true;
      }
    }
    if (moved) render();
    return left;
  }

  /** Scrolls the scroll containers around an element, then the page, so that its top shows. */
  function revealElement(element) {
    for (let node = element.parentElement; node && node.nodeType === 1; node = node.parentElement) {
      const geometry = scrollerGeometry(node);
      if (!geometry) continue;
      const target = viewportBounds(element);
      const container = viewportBounds(node);
      if (!target || !container) continue;
      const [borderTop, , , borderLeft] = styleEngine.get(node)?.borderWidths ?? [0, 0, 0, 0];
      setElementScroll(node, geometry.x + target.left - (container.left + borderLeft), geometry.y + target.top - (container.top + borderTop));
    }
    const bounds = viewportBounds(element);
    if (bounds) viewport.scrollTo(viewport.x, viewport.y + bounds.top);
    render();
  }

  /** Every <video> and <audio> gets its (painted) resource: size, frame, playing, time. */
  function initializeVideos(document, resources) {
    for (const element of document.querySelectorAll("video, audio")) {
      if (resources.get(element)) continue;
      const audioOnly = element.tagName === "AUDIO";
      resources.set(element, { width: audioOnly ? 300 : Number(element.getAttribute("width")) || 300,
        height: audioOnly ? 32 : Number(element.getAttribute("height")) || 150,
        bitmapWidth: 0, bitmapHeight: 0, image: null, playing: false, time: 0, duration: NaN });
    }
  }

  function videoSource(element) {
    const src = element.getAttribute("src") ?? element.querySelector("source[src]")?.getAttribute("src");
    try { return src ? new URL(src, page.url).href : null; } catch { return null; }
  }

  // ---- media: <video> and <audio> share one pipeline. An <audio> is media
  // whose picture is not shown (its box is only the 300x32 control bar), and
  // a video's own sound plays too. wasmpeg decodes (frames and PCM); PCM goes
  // to the controller, which plays it through PulseAudio paced to real time.
  // One clock: `base` is the position where the current run started and
  // `clockStart` when it did. Frames are drawn when the clock reaches them.
  // wasmpeg seeks video (to a keyframe) but not audio, so an audio seek
  // decodes forward and skips (from the start again when going back).

  /** HTMLMediaElement state for page script. */
  function mediaState(element) {
    const state = page.media.get(element);
    return { paused: !state?.playing, ended: Boolean(state?.ended), currentTime: state ? mediaTime(state) : 0,
      duration: state?.duration ?? NaN };
  }

  /** The element's playback state, created (not loaded) on first use. */
  function mediaStateFor(element) {
    const resource = page.resources.get(element);
    const url = videoSource(element);
    if (!videoDecoder || !resource || !url) return null;
    let state = page.media.get(element);
    if (state && state.url !== url) {
      closeMedia(state);
      state = null;
    }
    if (!state) {
      state = { element, url, resource, bytes: null, loading: null, showsPicture: element.tagName === "VIDEO",
        video: null, sound: null, playing: false, ended: false, duration: NaN, base: 0, clockStart: null,
        timer: null, lastTimeUpdate: -1, generation: loadGeneration, document: page.document };
      page.media.set(element, state);
    }
    return state;
  }

  /** Current position in seconds. */
  function mediaTime(state) {
    const running = state.playing && state.clockStart !== null ? (hostPerformance.now() - state.clockStart) / 1000 : 0;
    const time = state.base + running;
    return Number.isFinite(state.duration) ? Math.min(state.duration, time) : time;
  }

  /** Fires a media event (play, pause, ended, seeked, timeupdate...) at the element. */
  function mediaEvent(state, type) {
    if (state.document !== page.document || !page.realm) return;
    try {
      page.realm.dispatch(state.element, new page.window.Event(type));
    } catch {}
  }

  /** The control bar and frame redraw without a relayout. */
  function repaintMedia() {
    rasterized.list = null;
    render();
  }

  /** Fetches (once), probes, and opens the decoders for what the file holds. */
  function loadMedia(state) {
    state.loading ??= (async () => {
      if (!state.bytes) {
        const response = await fetchResource(state.url, state.showsPicture ? "video" : "audio");
        if (!response.ok) throw new Error(`media ${state.url} failed with HTTP ${response.status}`);
        state.bytes = response.body;
      }
      if (!Number.isFinite(state.duration) && !state.probed) {
        const probe = await videoDecoder.probe(state.bytes);
        state.probed = true;
        state.duration = probe.duration ?? NaN;
        state.hasVideo = state.showsPicture && probe.video?.width > 0;
        state.hasAudio = probe.audio?.sampleRate > 0;
        state.resource.duration = state.duration;
        mediaEvent(state, "loadedmetadata");
      }
      if (state.hasVideo && !state.video) await openVideoDecoder(state);
      if (state.hasAudio && audio && !state.sound) await openAudioDecoder(state);
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // FFmpeg probes the container; formats without magic bytes take a hint from the extension.
  function decodeOptions(state) {
    const hint = formatHint(new URL(state.url).pathname);
    return hint ? { format: hint } : {};
  }

  async function openVideoDecoder(state) {
    state.video?.decoder.close();
    const decoder = await videoDecoder.decode(state.bytes, decodeOptions(state));
    state.video = { decoder, frameTime: 0, done: false };
    trace?.(`video decoded ${state.url}: ${decoder.width}x${decoder.height}`);
    if (state.resource.width !== decoder.width || state.resource.height !== decoder.height) {
      state.resource.width = decoder.width;
      state.resource.height = decoder.height;
      page.dirty = true;
      refresh();
    }
  }

  async function openAudioDecoder(state) {
    state.sound?.decoder.close();
    const decoder = await videoDecoder.decodeAudio(state.bytes, decodeOptions(state));
    state.sound = { decoder, id: null, position: 0, pending: null, history: [], finishing: false, done: false };
    trace?.(`audio decoded ${state.url}: ${decoder.sampleRate} Hz, ${decoder.channels} channels`);
  }

  /** A click on the media: on its progress track it seeks, anywhere else it plays or pauses. */
  function clickMedia(element, x, y) {
    const box = viewportBounds(element);
    const state = page.media.get(element);
    const duration = state?.duration;
    if (box && Number.isFinite(duration) && duration > 0) {
      const layout = mediaBarLayout(box.width);
      const onBar = element.tagName === "AUDIO" || y - box.top >= box.height - MEDIA_BAR_HEIGHT;
      const relative = x - box.left;
      if (onBar && relative >= layout.trackStart - 6) {
        const fraction = Math.min(1, Math.max(0, (relative - layout.trackStart) / (layout.trackEnd - layout.trackStart)));
        void seekMedia(element, fraction * duration);
        return;
      }
    }
    if (state?.playing) pauseMedia(element);
    else void playMedia(element);
  }

  async function playMedia(element) {
    const state = mediaStateFor(element);
    if (!state || state.playing) return;
    setMediaPlaying(state, true);
    try {
      await loadMedia(state);
      if (state.ended) {
        state.ended = false;
        await positionMedia(state, 0);
      } else if (state.needsPosition) {
        // After a pause the audio decoder is ahead of where playing resumes.
        await positionMedia(state, state.base, { videoToo: false });
      }
      state.needsPosition = false;
    } catch (error) {
      if (state.document === page.document) reportError(error);
      closeMedia(state);
      page.media.delete(element);
      repaintMedia();
      return;
    }
    if (!state.playing || state.document !== page.document) return;
    if (!state.video && !state.sound) {
      // Nothing this engine can play (audio with no audio output).
      setMediaPlaying(state, false);
      reportError(new Error(`media ${state.url}: nothing to play`));
      return;
    }
    startMedia(state);
    mediaEvent(state, "play");
  }

  function pauseMedia(element) {
    const state = page.media.get(element);
    if (!state?.playing) return;
    state.base = mediaTime(state);
    stopClock(state);
    state.needsPosition = true;
    setMediaPlaying(state, false);
    mediaEvent(state, "pause");
  }

  async function seekMedia(element, seconds) {
    const state = mediaStateFor(element);
    if (!state) return;
    const wasPlaying = state.playing;
    if (wasPlaying) stopClock(state);
    try {
      await loadMedia(state);
      const target = Math.max(0, Math.min(Number.isFinite(state.duration) ? state.duration : Infinity, Number(seconds) || 0));
      state.ended = false;
      await positionMedia(state, target);
      state.needsPosition = false;
      // A paused video shows the frame it landed on.
      if (state.video && !wasPlaying) drawVideoFrame(state, true);
    } catch (error) {
      reportError(error);
      return;
    }
    if (wasPlaying && state.playing && state.document === page.document) startMedia(state);
    state.resource.time = mediaTime(state);
    repaintMedia();
    mediaEvent(state, "seeked");
    mediaEvent(state, "timeupdate");
  }

  /** Moves the decoders (and the clock's base) to `seconds`. */
  async function positionMedia(state, seconds, { videoToo = true } = {}) {
    state.base = seconds;
    if (state.video && videoToo) {
      if (state.video.done || seconds === 0) await openVideoDecoder(state);
      if (seconds > 0) state.video.decoder.seek(seconds * 1000);
      state.video.frameTime = seconds;
      state.video.done = false;
    }
    if (state.sound) await positionAudio(state, seconds);
  }

  /** Puts the audio decoder at `seconds`: from the kept history, by decoding ahead, or from the start. */
  async function positionAudio(state, seconds) {
    const sound = state.sound;
    const { sampleRate, channels } = sound.decoder;
    const target = Math.max(0, Math.round(seconds * sampleRate));
    sound.done = false;
    const historyStart = sound.history[0]?.start ?? Infinity;
    if (target >= historyStart && target < sound.position) {
      // Resume inside audio already decoded: take it from the history.
      const parts = [];
      for (const chunk of sound.history) {
        const frames = chunk.samples.length / channels;
        if (chunk.start + frames <= target) continue;
        parts.push(chunk.start >= target ? chunk.samples : chunk.samples.subarray((target - chunk.start) * channels));
      }
      if (sound.pending) parts.push(sound.pending);
      sound.pending = concatSamples(parts);
      sound.position = target;
      sound.history = [];
      return;
    }
    if (target < sound.position) await openAudioDecoder(state);
    const current = state.sound;
    current.history = [];
    if (current.pending) {
      const frames = current.pending.length / channels;
      if (current.position + frames > target) {
        current.pending = current.pending.subarray((target - current.position) * channels);
        current.position = target;
        return;
      }
      current.position += frames;
      current.pending = null;
    }
    while (current.position < target) {
      const samples = current.decoder.nextSamples();
      if (!samples) return;
      const frames = samples.length / channels;
      if (current.position + frames > target) {
        current.pending = samples.subarray((target - current.position) * channels);
        current.position = target;
        return;
      }
      current.position += frames;
    }
  }

  /** Starts the clock, the audio stream and the frame/time ticks. */
  function startMedia(state) {
    state.clockStart = hostPerformance.now();
    if (state.sound && !state.sound.done) openAudioStream(state);
    mediaTick(state);
  }

  function stopClock(state) {
    hostClearTimeout(state.timer);
    state.timer = null;
    state.clockStart = null;
    if (state.sound?.id != null) {
      audio.close(state.sound.id);
      state.sound.id = null;
      state.sound.finishing = false;
    }
  }

  /** Draws the frames the clock has reached, updates time, ends when everything has played. */
  function mediaTick(state) {
    if (!state.playing || state.generation !== loadGeneration || state.document !== page.document) return;
    const now = mediaTime(state);
    const video = state.video;
    if (video && !video.done && video.frameTime <= now) {
      // Late frames are decoded but only the newest is shown.
      while (video.frameTime <= now && !video.done) {
        const nextIsLate = video.frameTime + 1 / (video.decoder.fps || 30) <= now;
        if (!drawVideoFrame(state, !nextIsLate)) video.done = true;
      }
    }
    state.resource.time = now;
    repaintMedia();
    if (Math.floor(now * 4) !== state.lastTimeUpdate) {
      state.lastTimeUpdate = Math.floor(now * 4);
      mediaEvent(state, "timeupdate");
    }
    const videoFinished = !video || video.done;
    const soundFinished = !state.sound || state.sound.done;
    // The clock at the duration ends it too: after a seek, frames restart at a
    // keyframe before the target, and wasmpeg does not tell their timestamps.
    const pastEnd = Number.isFinite(state.duration) && state.clockStart !== null
      && state.base + (hostPerformance.now() - state.clockStart) / 1000 >= state.duration;
    if ((videoFinished && soundFinished) || (pastEnd && soundFinished)) return endMedia(state);
    const delay = video && !video.done ? Math.max(5, (video.frameTime - mediaTime(state)) * 1000) : 250;
    state.timer = hostSetTimeout(() => mediaTick(state), delay);
  }

  /** Decodes the next frame; shows it when `show`. False at the end of the stream. */
  function drawVideoFrame(state, show) {
    const decoder = state.video.decoder;
    const width = Math.min(480, decoder.width);
    const height = Math.max(1, Math.round(width * decoder.height / decoder.width));
    const pixels = decoder.nextFrame(width, height);
    if (!pixels) return false;
    state.video.frameTime += 1 / (decoder.fps || 30);
    if (!show) return true;
    const image = CanvasKit.MakeImage({ width, height, alphaType: CanvasKit.AlphaType.Unpremul,
      colorType: CanvasKit.ColorType.RGBA_8888, colorSpace: CanvasKit.ColorSpace.SRGB }, pixels, width * 4);
    if (!image) return true;
    state.resource.image?.delete();
    state.resource.image = image;
    state.resource.bitmapWidth = width;
    state.resource.bitmapHeight = height;
    return true;
  }

  function openAudioStream(state) {
    const sound = state.sound;
    sound.finishing = false;
    const name = new URL(state.url).pathname.split("/").pop() || "audio";
    const id = audio.open({ rate: sound.decoder.sampleRate, channels: sound.decoder.channels, name }, (event) => {
      if (sound.id !== id) return;
      if (event.event === "request") feedAudio(state, event.bytes);
      else if (event.event === "ended") {
        sound.id = null;
        sound.done = true;
        mediaTick(state);
      } else if (event.event === "error") {
        sound.id = null;
        sound.done = true;
        reportError(new Error(`audio: ${event.message}`));
        // Video plays on without sound; audio alone stops.
        if (!state.video) pauseMedia(state.element);
      }
    });
    sound.id = id;
  }

  /** Sends about `bytes` of s16le audio (pending samples first, then decoding); at the end, lets it drain. */
  function feedAudio(state, bytes) {
    const sound = state.sound;
    if (!state.playing || sound.id === null || sound.finishing) return;
    const { channels, sampleRate } = sound.decoder;
    const frameBytes = channels * 2;
    for (let sent = 0; sent + frameBytes <= bytes;) {
      let samples = sound.pending;
      sound.pending = null;
      samples ??= sound.decoder.nextSamples();
      if (!samples) {
        sound.finishing = true;
        audio.finish(sound.id);
        return;
      }
      const [taken, remaining] = splitSamples(samples, channels, bytes - sent);
      if (remaining.length) sound.pending = remaining;
      sound.history.push({ start: sound.position, samples: taken });
      sound.position += taken.length / channels;
      while (sound.history.length > 1 && sound.position - sound.history[1].start > AUDIO_HISTORY_SECONDS * sampleRate) {
        sound.history.shift();
      }
      const pcm = floatToS16(taken);
      audio.write(sound.id, pcm);
      sent += pcm.length;
    }
  }

  function endMedia(state) {
    stopClock(state);
    state.ended = true;
    state.base = Number.isFinite(state.duration) ? state.duration : state.base;
    setMediaPlaying(state, false);
    mediaEvent(state, "pause");
    mediaEvent(state, "ended");
  }

  function setMediaPlaying(state, playing) {
    state.playing = playing;
    state.resource.playing = playing;
    state.resource.time = mediaTime(state);
    if (state.document === page.document) repaintMedia();
  }

  function closeMedia(state) {
    stopClock(state);
    state.playing = false;
    state.video?.decoder.close();
    state.video = null;
    state.sound?.decoder.close();
    state.sound = null;
    state.resource.image?.delete();
    state.resource.image = null;
    state.resource.playing = false;
  }

  function disposeVideos() {
    for (const state of page.media.values()) closeMedia(state);
    page.media.clear();
  }

  function concatSamples(parts) {
    const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /** The decoded CSS background image a url() names, if it has arrived. */
  function backgroundResource(url) {
    let absolute;
    try { absolute = new URL(url, page.url).href; } catch { return null; }
    return page.backgrounds.get(absolute)?.resource ?? null;
  }

  /**
   * Requests the background images the laid-out document uses and has not
   * asked for yet. They change only paint: each repaints the page on arrival.
   */
  function queueBackgroundImages() {
    const tree = page.renderTree;
    if (!tree) return;
    const document = page.document;
    const seen = new Set();
    for (const node of tree.nodesById.values()) {
      const value = node.style?.backgroundImage;
      if (!value || seen.has(value) || !value.includes("url(")) continue;
      seen.add(value);
      for (const match of value.matchAll(CSS_URL)) {
        let url;
        try { url = new URL(match[2], page.url).href; } catch { continue; }
        if (page.backgrounds.has(url)) continue;
        const entry = { resource: null, loaded: null };
        page.backgrounds.set(url, entry);
        entry.loaded = fetchResource(url, "image").then(async (response) => {
          if (!response.ok || page.backgrounds.get(url) !== entry) return;
          const bytes = response.body;
          const { width, height } = await new Bun.Image(bytes).metadata();
          const image = CanvasKit.MakeImageFromEncoded(bytes);
          if (!image) return;
          if (page.backgrounds.get(url) !== entry || document !== page.document) {
            image.delete();
            return;
          }
          entry.resource = Object.freeze({ width, height, image, url });
          if (page.layout) page.displayList = paintList();
          page.needsPaint = true;
          scheduleFrame();
        }).catch(() => {
          // A broken background image paints nothing.
        });
      }
    }
  }

  function disposeBackgrounds() {
    for (const entry of page.backgrounds.values()) entry.resource?.image.delete();
    page.backgrounds = new Map();
  }

  function queueImageResources() {
    const document = page.document;
    const generation = loadGeneration;
    const staleImages = [];
    for (const element of document.querySelectorAll("img")) {
      const src = element.getAttribute("src");
      if (!src || imageRequests.get(element) === src) continue;
      let url;
      try { url = new URL(src, page.url).href; } catch { continue; }
      if (page.resources.get(element)?.url === url) {
        imageRequests.set(element, src);
        continue;
      }
      imageRequests.set(element, src);
      const oldImage = page.resources.get(element)?.image;
      if (oldImage) staleImages.push(oldImage);
      page.resources.delete(element);
      fetchResource(url, "image").then(async (response) => {
        if (!response.ok) return;
        const bytes = response.body;
        const { width, height } = await new Bun.Image(bytes).metadata();
        const image = CanvasKit.MakeImageFromEncoded(bytes);
        if (!image) return;
        if (generation !== loadGeneration || document !== page.document || element.getAttribute("src") !== src) {
          image.delete();
          return;
        }
        page.resources.set(element, Object.freeze({ width, height, image, url: response.url }));
        page.decodedImages.push(image);
        const node = [...page.renderTree.nodesById.values()].find((candidate) => candidate.domNode === element);
        const run = page.layout.fragments.flatMap((fragment) => fragment.runs)
          .find((candidate) => candidate.type === "image" && candidate.nodeId === node?.id);
        const cssWidth = node?.style?.width;
        const cssHeight = node?.style?.height;
        const specifiedWidth = typeof cssWidth === "number" ? cssWidth : node?.widthAttribute;
        const specifiedHeight = typeof cssHeight === "number" ? cssHeight : node?.heightAttribute;
        // When both used dimensions were already fixed, decoded pixels only
        // change paint. The retained layout remains authoritative and the
        // display list resolves the current resource by DOM node.
        const paintOnly = run && Number.isFinite(specifiedWidth) && Number.isFinite(specifiedHeight)
          && Math.abs(run.width - specifiedWidth) < 0.01 && Math.abs(run.height - specifiedHeight) < 0.01;
        if (paintOnly) {
          page.displayList = paintList();
          page.needsPaint = true;
        } else {
          page.dirty = true;
          page.resourceLayoutDirty = true;
        }
        refresh();
      }).catch(() => {
        // A failed image retains its fallback replaced-element dimensions.
      });
    }
    return staleImages;
  }
}

function canvasColor(CanvasKit, value) {
  const match = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  return match
    ? CanvasKit.Color(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]))
    : CanvasKit.BLACK;
}

/**
 * Applies a document.cookie assignment to the local copy until the
 * controller's jar (the authority) reports the next value.
 */
function mergeDocumentCookie(current, assignment) {
  const [pair, ...attributes] = assignment.split(";");
  const equals = pair.indexOf("=");
  if (equals < 1) return current;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  const expired = attributes.some((attribute) => {
    const [key, argument = ""] = attribute.split("=").map((part) => part.trim().toLowerCase());
    return (key === "max-age" && Number(argument) <= 0)
      || (key === "expires" && Date.parse(argument) <= Date.now());
  });
  const entries = current ? current.split("; ").filter((entry) => !entry.startsWith(`${name}=`)) : [];
  if (!expired) entries.push(`${name}=${value}`);
  return entries.join("; ");
}

/** Page values leave the renderer only as primitives or JSON data. */
function cloneableResult(value) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function documentBackground(document, styleEngine) {
  for (const element of [document.body, document.documentElement]) {
    const color = element && styleEngine.get(element).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)") return color;
  }
  return "rgba(255, 255, 255, 1)";
}

function emptyImageResources() {
  return { map: new WeakMap(), decoded: [], entries: [] };
}

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
import {isTextInput, moveInputSelection, inputClipboard, selectInput} from './text-input.js';
import {inputPresentation, inputOwner, inputCaretNode} from './text-input-paint.js';
import CanvasKitInit from "../../usr/lib/canvaskit/canvaskit.js";
import { setCanvasKit, canvasResource, observeDocumentCanvases } from "./canvas-2d.js";
import { createCanvasTextRenderer, parseCanvasFont } from "./canvas-text.js";
import { DESKTOP_USER_AGENT } from "../user-agent.js";
import { DocumentCookies } from "./document-cookies.js";

// qml handle begin: optional software shader canvas bridge
import {paintQmlCanvas} from './canvas-2d.js';
import {createShaderRenderer} from '../qml/shader/renderer.js';
// qml handle end

// qml handle begin: optional document frontend
import {createQmlMediaController,applyQmlMediaGain} from '../qml/media-renderer.js';
import {INTERFACES as qmlBindings} from "./bindings.js";
import { enableQmlDomImages, hasQmlDomImages, captureQmlDomImage, filterQmlTextureSources, qmlTextureVisibilityChanged } from "../qml/canvas-dom.js";
import {loadQmlFonts} from '../qml/fonts.js';
import {createQmlHost} from "../qml/host.js";
import { loadQmlDocument } from "../qml/document.js";
import { isQmlDocument } from "../qml/format.js";
// qml handle end

import { parseHTMLDocument } from "../happy-dom/parser.js";
import { LayoutEngine } from "../layout/text-layout.js";
import { ScrollViewport } from "../layout/scroll-viewport.js";
import { scrollAlignmentDelta } from "./scroll-into-view.js";
import { elementAtPoint, elementBounds, elementBox, hitTest, interactiveRegions, renderNodeAtPoint } from "../input/hit-test.js";
import { beginImageLoad, finishImageLoad } from "./image-loading.js";
import { createImageResourceLoader, imageCrossOrigin, imageRequestKey } from "./image-resources.js";
import { createResourceElements } from "./resource-elements.js";
import { DocumentFonts } from "./font-loading.js";
import { dispatchPointerMove } from "./pointer-move.js";
import { keyboardInput } from "./keyboard-input.js";
import { playbackEvent } from "./media-playback-events.js";
import { repaintLayout } from "../layout/repaint.js";
import { RenderTreeBuilder, renderTreeText, sameLayoutInput } from "../render-tree/index.js";
import { absolutizeStyleSheetUrls, extractFontFaces, matchSelectors, mediaQueryMatches, StyleEngine, topmostConnected } from "../style/computed-style.js";
import { compileSelector, matchesCompiled } from "../happy-dom/selector-matcher.js";
import { elementFeatures, sheetTraits } from "../style/selector-traits.js";
import { buildDisplayList, visibleItems } from "../paint/display-list.js";
import { backgroundBytes, rawFrame, captureViewport, cropViewport, encodeImageBase64 } from "../paint/frame.js";
import { FrameCaptureCache } from "../paint/frame-cache.js";
import { RasterReadback } from "../paint/raster-readback.js";
import { rasterVideoMask, videoMaskBounds, videoMaskItems, videoLayerGeometry } from "./video-mask.js";
import { compositeVideo } from "./video-presentation.js";
import { insetRadii, roundedRect } from "../paint/rounded-rect.js";
import { appendParagraphText } from "../paint/paragraph-text.js";
import { CLASSIC_SCRIPT_TYPES, createPageRealm } from "./page-realm.js";
import { originOf } from "./messaging.js";
import { MOBILE_USER_AGENT } from "./flags.js";
import { formatHint } from "../../vendor/wasmpeg/src/js/formats.js";
import { containerFormat } from "./media-source.js";
import { floatToS16, splitSamples } from "../audio/pcm.js";
import { advanceAudio } from "../media/position-audio.js";
import { seekVideoKeyframe } from "../media/video-keyframe.js";
import { PianoMixer } from "../audio/piano.js";
import { handlePianoInput } from "./piano-input.js";

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
// After a stall, playing resumes once this much more media has arrived (or
// the wait gives up): resuming on the first bytes stalls again at once on a
// slow network.
const RESUME_BUFFER_SECONDS = 2;
const RESUME_BUFFER_MAX_WAIT_MS = 6000;
const RESUME_BUFFER_IDLE_MS = 400;
// element → MediaSource, and the reverse. One renderer owns one page pipeline.
const elementSources = new WeakMap();
const sourceElements = new WeakMap();
// srcObject is independent of the src attribute and takes precedence over it.
const elementSourceObjects = new WeakMap();

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
    // Page <canvas> uses this same instance. Two CanvasKit instances cannot share images.
    setCanvasKit(CanvasKit);
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
    const builtinTypefaces = [...loadedFamilies.values()].map(family => ({
      family, typeface: fontProvider.matchFamilyStyle(family, {
        weight: 400, width: 5, slant: CanvasKit.FontSlant.Upright,
      }),
    })).filter(entry => entry.typeface);

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
      genericFamilies, builtinTypefaces,
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
  clipboardReadInput = () => clipboardRead(),
  clipboardWriteInput = text => clipboardWrite(text),
  clipboardRead = () => Promise.reject(Error("Clipboard unavailable")),
  clipboardWrite = () => Promise.reject(Error("Clipboard unavailable")),
  webSockets = null,
  audio = null,
  setCookie = () => {},
  documentCookies = new DocumentCookies(setCookie),
  inheritedCookieUrl = null,
  consoleMessage = null,
  trace = null,
  onFrame = null,
  onVideo = null,
  onLifecycle = null,
  videoDecoder = null,
  // Prepares a classic script on another thread: (source) => Promise<{ code, parsed, strict }>.
  rewriteScript = null,
  mobile = false,
  verifyStyle = false,
  fullStyle = false,
  renderMinInterval = 16,
  // An iframe's document (see syncFrames): frames go to the embedding page,
  // which needs only the viewport, so nothing is painted ahead.
  embedded = false,
  allocateFramePixels = null,
  // This document's window handle, made by the embedding page (see windowHandle).
  frameWindow = null,
}, {
  CanvasKit, loadedFamilies, fontCollection, fontFamilies, sansSerifFamily, monospaceFamily, monospaceBoldFamily,
  genericFamilies, builtinTypefaces,
}) {
  // qml handle begin: preserve ordinary page fonts across QML navigation
  const standardFonts = {CanvasKit, loadedFamilies, fontCollection, fontFamilies, builtinTypefaces};
  // qml handle end

  let documentFonts = null;
  let fontSheets = null;
  let fontEnvironment = "";
  let fontDefinitions = [];
  let fontDefinitionKey = "[]";
  const resolvedFamilies = new Map();
  /** First available family from a computed font-family list, then the UI fallbacks. */
  function resolveFontFamilies(families = ["sans-serif"], weight = 400, fontStyle = "normal", point = null, stretch = 100) {
    const bold = weight >= 600;
    const key = `${weight}/${fontStyle}/${stretch}\n${families.join("\n")}`;
    let resolved = point === null && resolvedFamilies.get(key);
    if (!resolved) {
      let primary = [];
      for (const family of families) {
        const web = documentFonts?.resolve(family, weight, fontStyle, point, stretch);
        if (web?.length) { primary.push(...web); continue; }
        const builtin = loadedFamilies.get(family.toLowerCase()) ?? genericFamilies.get(family.toLowerCase());
        if (builtin) { primary.push(bold && builtin === monospaceFamily ? monospaceBoldFamily : builtin); break; }
      }
      if (!primary.length) primary = [sansSerifFamily];
      resolved = [...primary, ...fontFamilies.filter((family) => !primary.includes(family))];
      if (point === null) resolvedFamilies.set(key, resolved);
    }
    return resolved;
  }
  const renderTreeBuilder = new RenderTreeBuilder();
  let layoutEngine = new LayoutEngine({ measureText, fontMetrics });
  const styleEngine = new StyleEngine({ measureText, deferHidden: true });
  // Incremental restyle: what may have changed style since the last
  // computation. DOM mutations come from a MutationObserver; state that is
  // not in the DOM tree (checked, value, focus) is marked by the code that
  // changes it. `full` asks for a complete restyle.
  const styleChanges = { full: true, roots: new Set(), rootFeatures: new Map(), records: [], observer: null,
    activeElement: null, focusAncestors: new Set() };
  let resourceElements = null;
  let selectorTraits = { sibling: false, has: null, sheets: null };
  let lastStyleParts = "";
  let laidOutSheets = null;
  let computedSheets = null;
  let computedEnvironment = null;
  // A style-only CSSOM read may consume mutation records before layout runs.
  // Keep that work pending so a later geometry read cannot reuse stale boxes.
  let styleLayoutPending = false;
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
  let pointerButtons = 0, suppressPointerMouse = false;
  const pointerPresses = new Map();
  let selectionDrag = null;
  let selectionVersion = 0;
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
    resourcePaintDirty: false,
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
    imageElements: new Set(),
    imagesLoaded: null,
    // CSS background images by absolute URL: { resource, loaded } (see queueBackgroundImages).
    backgrounds: new Map(),
    // Scroll offsets of scroll containers, by element (see setElementScroll).
    elementScroll: new Map(),
    // Bumped whenever boxes may have moved (layout, element scrolling), so
    // IntersectionObserver checks can skip unchanged frames.
    layoutVersion: 0,
    // <video> and <audio> playback states, by element (see playMedia).
    media: new Map(),
    realm: null,
    // "off" until the renderer process has set up its sandbox.
    scripting: "off",
    dirty: false,
    resourceLayoutDirty: false,
    userAgent: mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
  };

  const cookieUrl = () => page.url === "about:blank" && inheritedCookieUrl ? inheritedCookieUrl() : page.url;
  function acceptCookies(response, url = cookieUrl()) {
    if (!documentCookies.accept(response.cookieState)) documentCookies.seed(url, response.documentCookie, true);
  }

  async function fetchResource(url, kind) {
    const generation = loadGeneration;
    const response = await rawFetchResource(url, kind);
    if (generation === loadGeneration) acceptCookies(response);
    return response;
  }
  const loadImageResource = createImageResourceLoader(CanvasKit, fetchResource, pageFetch);
  const renderCanvasText = createCanvasTextRenderer(CanvasKit, makeParagraph);

  function resetDocumentFonts() {
    documentFonts?.dispose();
    fontSheets = null;
    fontDefinitions = [];
    if (fontDefinitionKey !== "[]") clearFontCaches();
    fontEnvironment = "";
    fontDefinitionKey = "[]";
    documentFonts = new DocumentFonts({
      CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection, fetch: pageFetch,
      availableFamilies: new Set([...loadedFamilies.keys(), ...genericFamilies.keys()]),
      changed() {
        if (disposedRenderer) return;
        clearFontCaches();
        // Layout caches retain shaping, normal line-height and intrinsic
        // sizes by style/node identity. A loaded typeface changes those even
        // when CSS values stay the same; reset them only on font completion.
        layoutEngine = new LayoutEngine({ measureText, fontMetrics });
        // ch (including a root font-size) also changes computed CSS. Other
        // documents need fresh layout, while retaining their existing styles.
        if (styleEngine.usesFontMetrics) styleChanges.full = true;
        page.dirty = true;
        page.resourceLayoutDirty = true;
        page.needsPaint = true;
        scheduleFrame();
      },
      error: error => trace?.(`font failed: ${error?.message ?? error}`),
    });
  }

  function clearFontCaches() {
    resolvedFamilies.clear();
    measuredWidths.clear();
    measuredCount = 0;
    fontKeys = new WeakMap();
    fontMetricsCache.clear();
    clearPaintParagraphs();
    rasterized.list = null;
  }

  function queueFontLoads() {
    if (page.renderTree && fontDefinitions.length) documentFonts.update(fontDefinitions,
      [...page.renderTree.nodesById.values()].filter(node => node.type === "text"));
  }

  // Keep fractional CSS sizes through measurement and painting. Rounding each
  // scale independently can widen painted glyphs beyond the measured line.
  function makeParagraph(text, computedStyle = null, fontSize = computedStyle?.fontSize ?? 16, scale = 1, foregroundPaint = null) {
    const color = canvasColor(CanvasKit, computedStyle?.color ?? "rgba(0, 0, 0, 1)");
    const weight = computedStyle?.fontWeight ?? 400;
    const fontStyle = computedStyle?.fontStyle ?? "normal";
    const stretch = computedStyle?.fontStretch ?? 100;
    const widths = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
    const width = widths.reduce((best, value, index) => Math.abs(value - stretch) < Math.abs(widths[best] - stretch) ? index : best, 4) + 1;
    const slant = fontStyle === "italic" ? CanvasKit.FontSlant.Italic
      : fontStyle === "oblique" ? CanvasKit.FontSlant.Oblique : CanvasKit.FontSlant.Upright;
    const families = resolveFontFamilies(computedStyle?.fontFamily, weight, fontStyle, null, stretch);
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
        fontSize: Math.max(1, fontSize) * scale,
        fontStyle: { weight, slant, width },
        // Roboto is a variable font; static fonts ignore the axis and match by weight.
        fontVariations: [{ axis: "wght", value: weight }, { axis: "wdth", value: stretch }],
        ...decoration,
      },
      maxLines: 1,
      ...(computedStyle?.direction ? { textDirection: computedStyle.direction === "rtl" ? CanvasKit.TextDirection.RTL : CanvasKit.TextDirection.LTR } : {}),
    });
    const builder = CanvasKit.ParagraphBuilder.MakeFromFontCollection(style, documentFonts?.collection ?? fontCollection);
    const backgroundPaint = foregroundPaint ? new CanvasKit.Paint() : null;
    if (backgroundPaint) backgroundPaint.setColor(CanvasKit.TRANSPARENT);
    const pushTextStyle = foregroundPaint
      ? value => builder.pushPaintStyle(value, foregroundPaint, backgroundPaint) : value => builder.pushStyle(value);
    const textStyle = (fontFamilies) => CanvasKit.TextStyle({ color, ...decoration, fontFamilies,
      fontSize: Math.max(1, fontSize) * scale, fontStyle: { weight, slant, width },
      fontVariations: [{ axis: "wght", value: weight }, { axis: "wdth", value: stretch }] });
    function append(text, fonts) {
      let emojiStyle;
      const writer = foregroundPaint ? { addText: value => builder.addText(value), pushStyle: pushTextStyle, pop: () => builder.pop() } : builder;
      appendParagraphText(writer, text, () => emojiStyle ??= textStyle([
        ...fonts.filter(name => name.includes("Emoji")), ...fonts.filter(name => !name.includes("Emoji")),
      ]));
    }
    if (foregroundPaint) pushTextStyle(textStyle(families));
    if (documentFonts?.hasUnicodeRanges && text) {
      // A downloaded subset may physically contain more glyphs than its CSS
      // unicode-range permits. Apply the range when choosing native families,
      // preserving whole adjacent runs for shaping instead of per-letter calls.
      const choices = new Map();
      let run = "", previous = null, previousKey = "";
      const flush = () => {
        if (!run) return;
        pushTextStyle(textStyle(previous));
        append(run, previous);
        builder.pop();
      };
      for (const character of text) {
        const point = character.codePointAt(0);
        let choice = choices.get(point);
        if (!choice) {
          const fonts = resolveFontFamilies(computedStyle?.fontFamily, weight, fontStyle, point, stretch);
          choices.set(point, choice = { fonts, key: fonts.join("\n") });
        }
        if (run && choice.key !== previousKey) { flush(); run = ""; }
        previous = choice.fonts;
        previousKey = choice.key;
        run += character;
      }
      flush();
    } else append(text, families);
    if (foregroundPaint) builder.pop();
    const paragraph = builder.build();
    builder.delete();
    backgroundPaint?.delete();
    return paragraph;
  }

  // Text widths depend only on the font (families, fractional size, weight),
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
      width = {width:paragraph.getMaxIntrinsicWidth(),ascent:paragraph.getAlphabeticBaseline(),height:paragraph.getHeight()};
      paragraph.delete();
      if (++measuredCount > MAX_MEASURED_TEXTS) {
        measuredWidths.clear();
        measuredCount = 1;
        measuredWidths.set(fontKey, widths = new Map());
      }
      widths.set(text, width);
    }
    return width.width;
  }

  // Computed styles are immutable and shared, so each one's key is computed once.
  let fontKeys = new WeakMap();
  function fontKeyOf(computedStyle) {
    if (computedStyle && typeof computedStyle === "object") {
      const cached = fontKeys.get(computedStyle);
      if (cached) return cached;
    }
    const weight = computedStyle?.fontWeight ?? 400;
    const fontStyle = computedStyle?.fontStyle ?? "normal";
    const stretch = computedStyle?.fontStretch ?? 100;
    const key = `${Math.max(1, computedStyle?.fontSize ?? 16)}/${weight}/${fontStyle}/${stretch}/${
      resolveFontFamilies(computedStyle?.fontFamily, weight, fontStyle, null, stretch).join(",")}`;
    if (computedStyle && typeof computedStyle === "object") fontKeys.set(computedStyle, key);
    return key;
  }

  const fontMetricsCache = new Map();
  function fontMetrics(computedStyle = null, text = null) {
    const key = fontKeyOf(computedStyle);
    if(text) {
      measureText(text,computedStyle);
      return measuredWidths.get(key).get(text);
    }
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
  let syncedViewport = { width: 0, height: 0 };
  let tileSerial = 0;
  let lastTile = null;
  const captures = new FrameCaptureCache();
  let prepaintTimer = null;
  let frameTimer = null;
  let lastRebuildMs = 0;

  // What the latest tile was rasterized from. A rebuild that produces the
  // same display list (script changes that do not affect rendering, repeated
  // relayouts) reuses the tile instead of rasterizing again, like Blink's
  // PaintController reusing cached display items
  // (platform/graphics/paint/paint_controller.cc, BSD).
  let rasterized = { list: null, overlay: "", background: "", scale: 0 };
  let nextVideoPresentation = 1;
  let rasterSurface = null;
  let rasterSurfaceWidth = 0;
  let rasterSurfaceHeight = 0;
  let rasterRegion = null;
  const rasterReadback = new RasterReadback(CanvasKit, { shared: Boolean(onFrame), allocate: allocateFramePixels });
  // A scroll or unrelated DOM update does not change text shaping. Keep a
  // bounded set of visible paragraphs keyed by their complete shaping input.
  // Both limits matter: a page may contain many unique or very long strings.
  const paintedParagraphs = new Map();
  let paragraphKeys = new WeakMap();
  let paintedCharacters = 0;
  const MAX_PAINT_PARAGRAPHS = 256;
  const MAX_PAINT_CHARACTERS = 64_000;

  function releasePaintParagraph(key, entry) {
    entry.paragraph.delete();
    paintedParagraphs.delete(key);
    paintedCharacters -= entry.characters;
  }

  function clearPaintParagraphs() {
    renderCanvasText.clear();
    for (const entry of paintedParagraphs.values()) entry.paragraph.delete();
    paintedParagraphs.clear();
    paragraphKeys = new WeakMap();
    paintedCharacters = 0;
  }

  function paragraphForPaint(item, scale, width) {
    const retained = item.text.length <= 4096;
    let cachedKey = retained && paragraphKeys.get(item);
    if (retained && (!cachedKey || cachedKey.scale !== scale || cachedKey.width !== width)) {
      cachedKey = { scale, width, key: JSON.stringify([item.text, item.color, item.font,
        item.decoration, scale, width]) };
      paragraphKeys.set(item, cachedKey);
    }
    const key = cachedKey?.key;
    let entry = retained && paintedParagraphs.get(key);
    if (entry) {
      paintedParagraphs.delete(key);
      paintedParagraphs.set(key, entry);
      return entry;
    }
    const paragraph = makeParagraph(item.text, {
      color: item.color, fontSize: item.font.size, fontWeight: item.font.weight, fontFamily: item.font.family,
      fontStyle: item.font.style, fontStretch: item.font.stretch,
      decoration: item.decoration,
    }, undefined, scale);
    try {
      paragraph.layout(width);
    } catch (error) {
      paragraph.delete();
      throw error;
    }
    entry = { paragraph, retained, characters: item.text.length };
    if (entry.retained) {
      paintedParagraphs.set(key, entry);
      paintedCharacters += item.text.length;
      while (paintedParagraphs.size > MAX_PAINT_PARAGRAPHS || paintedCharacters > MAX_PAINT_CHARACTERS) {
        const [oldKey, oldEntry] = paintedParagraphs.entries().next().value;
        releasePaintParagraph(oldKey, oldEntry);
      }
    }
    return entry;
  }

  /** Hint overlay contents, as a comparable key. */
  function overlayKey() {
    const hints = page.hintsVisible
      ? page.hints.map((hint) => `${hint.label}@${hint.x + hint.scrollX},${hint.y + hint.scrollY}`).join(";")
      : "";
    const selection=page.window?.getSelection();
    return hints + selectionVersion + (selection?.rangeCount ? `:${selection.anchorOffset}:${selection.focusOffset}:${selection.toString()}` : "");
  }

  function sameRasterInput() {
    if (rasterized.scale !== page.deviceScaleFactor || rasterized.background !== page.backgroundColor) return false;
    if (rasterized.overlay !== overlayKey()) return false;
    if (rasterized.frames !== framesVersion) return false;
    if (page.displayList?.items.some((item) => item.fixed)
      && (rasterized.scrollX !== viewport.x || rasterized.scrollY !== viewport.y)) return false;
    if (rasterized.list === page.displayList) return true;
    if (rasterized.list?.images.length !== page.displayList?.images.length
      || page.displayList?.images.some((resource, index) => resource !== rasterized.list.images[index])) return false;
    if (!rasterized.list || !page.displayList || !Bun.deepEquals(rasterized.list.items, page.displayList.items)) return false;
    rasterized.list = page.displayList;
    return true;
  }

  /** Rasterizes the viewport and hands it to the compositor. */
  function render() {
    if (disposedRenderer) return;
    if (page.resourcePaintDirty) {
      page.displayList = paintList();
      page.resourcePaintDirty = false;
    }
    page.realm?.layoutChanged(page.layoutVersion);
    if (onVideo) for (const state of page.media.values()) readPresentedFrame(state);
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const region = { x: viewport.x, y: viewport.y, width, height };
    if (lastTile && tileCovers(lastTile, region) && sameRasterInput()) {
      page.needsPaint = false;
      // Only this thread's scroll position changed: tell the compositor.
      if (viewport.x !== syncedScroll.x || viewport.y !== syncedScroll.y
        || page.width !== syncedViewport.width || page.height !== syncedViewport.height) publish(lastTile);
    } else {
      // Keep a previously prepainted region during ordinary page updates.
      // Shrinking to the viewport and expanding again 30ms later used to
      // rasterize each animation twice and repeatedly resize native surfaces.
      const retained = !page.loading && lastTile && tileCovers(lastTile, region)
        && lastTile.height <= height * 2.5;
      publish(rasterTile(retained ? { x: lastTile.x, y: lastTile.y, width: lastTile.width, height: lastTile.height } : region));
    }
    schedulePrepaint();
  }

  /** Conservative canvas-only damage, in document CSS pixels. */
  function canvasDamage(region) {
    const old = rasterized.list, next = page.displayList;
    // Reuse pixels only when geometry and every non-canvas input are stable.
    // Transformed/fixed canvases conservatively take the full-paint path.
    if (!rasterSurface || !Bun.deepEquals(rasterRegion, region)
      || rasterized.scale !== page.deviceScaleFactor || rasterized.background !== page.backgroundColor
      || rasterized.overlay !== overlayKey() || rasterized.frames !== framesVersion
      || rasterized.scrollX !== viewport.x || rasterized.scrollY !== viewport.y
      || !old || !next || old.images.length !== next.images.length
      || !Bun.deepEquals(old.items, next.items)
      || next.items.some(item => item.op === 'drawVideo')) return null;
    let damage = null;
    for (let i = 0; i < next.images.length; i++) {
      if (old.images[i] === next.images[i]) continue;
      const uses = next.items.filter(item => item.image === i);
      if (!uses.length) return null;
      for (const item of uses) {
        if (item.op !== 'drawImage' || item.fixed || item.transform
          || page.renderTree.nodesById.get(item.nodeId)?.domNode?.tagName !== 'CANVAS') return null;
        const r = item.rect;
        if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return null;
        const left = r.x - 1, top = r.y - 1, right = r.x + r.width + 1, bottom = r.y + r.height + 1;
        damage = damage ? {x:Math.min(damage.x,left),y:Math.min(damage.y,top),right:Math.max(damage.right,right),bottom:Math.max(damage.bottom,bottom)}
          : {x:left,y:top,right,bottom};
      }
    }
    return damage;
  }

  /** Rasterizes a page rectangle (CSS pixels) into RGBA pixels. */
  function rasterTile(region) {
    // Prepaint can run before a queued canvas/image repaint. Refresh native
    // snapshots here too: the old display list may hold a released image.
    if (page.resourcePaintDirty) {
      page.displayList = paintList();
      page.resourcePaintDirty = false;
    }
    const scale = page.deviceScaleFactor;
    const pixelWidth = Math.max(1, Math.round(region.width * scale));
    const pixelHeight = Math.max(1, Math.round(region.height * scale));
    // The independent compositor already reconstructs an opaque video from
    // black/white masks. Reuse that path for the ordinary tile too, avoiding
    // a large Skia image upscale and a second black pass on each UI repaint.
    const blackPlan = blackVideoPlan(region);
    const damage = canvasDamage(region);
    if (damage) trace?.(`${page.url}: canvas damage ${damage.right-damage.x}x${damage.bottom-damage.y}`);
    if (!rasterSurface || rasterSurfaceWidth !== pixelWidth || rasterSurfaceHeight !== pixelHeight) {
      // MakeSurface owns a malloc-backed pixel buffer; delete() alone leaks it.
      rasterSurface?.dispose();
      rasterSurface = CanvasKit.MakeSurface(pixelWidth, pixelHeight);
      rasterSurfaceWidth = pixelWidth;
      rasterSurfaceHeight = pixelHeight;
    }
    const surface = rasterSurface;
    if (!surface) throw new Error(`Unable to create a ${pixelWidth}x${pixelHeight} CanvasKit surface`);
    const canvas = surface.getCanvas();
    canvas.save();
    if (damage) canvas.clipRect(CanvasKit.LTRBRect(
      Math.floor((damage.x-region.x)*scale), Math.floor((damage.y-region.y)*scale),
      Math.ceil((damage.right-region.x)*scale), Math.ceil((damage.bottom-region.y)*scale),
    ), CanvasKit.ClipOp.Intersect, false);
    // Clear and replay all layers inside the damage, including backgrounds
    // and foreground occluders. Transparent canvas pixels must not leave trails.
    canvas.clear(canvasColor(CanvasKit, page.backgroundColor));
    paintDisplayList(canvas, page.displayList, region, scale, blackPlan ? {resource:blackPlan.resource,white:false} : null, damage ? {
      x:damage.x, y:damage.y, width:damage.right-damage.x, height:damage.bottom-damage.y,
    } : region);
    drawHints(canvas, region);
    canvas.restore();
    surface.flush();
    const image = surface.makeImageSnapshot();
    let pixels;
    try { pixels = rasterReadback.read(image, pixelWidth, pixelHeight); }
    finally { image.delete(); }
    const videoLayer = makeVideoLayer(canvas, surface, region, scale, pixelWidth, pixelHeight, pixels, blackPlan?.resource);
    if (blackPlan && !videoLayer) {
      // An injected callback may invalidate presentation during the paint.
      // Recover the ordinary pixels before publishing an unlayered tile.
      canvas.save();
      try {
        canvas.clear(canvasColor(CanvasKit, page.backgroundColor));
        paintDisplayList(canvas, page.displayList, region, scale);
        drawHints(canvas, region);
      } finally { canvas.restore(); }
      surface.flush();
      const retryImage = surface.makeImageSnapshot();
      try { pixels = rasterReadback.read(retryImage, pixelWidth, pixelHeight); }
      finally { retryImage.delete(); }
    }
    if (blackPlan && videoLayer) {
      const composed = compositeVideo({pixels,pixelWidth,pixelHeight,x:region.x,y:region.y,width:region.width,height:region.height,scale,videoLayer},blackPlan.frame);
      // Preserve the caller's shared readback allocation and tile contract.
      pixels.set(composed.pixels);
    }
    page.needsPaint = false;
    rasterRegion = {...region};
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
      videoLayer,
    };
  }

  function publish(tile) {
    lastTile = tile;
    tileSerial++;
    syncedViewport = { width: page.width, height: page.height };
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
  function schedulePrepaint(delay = 30) {
    if (disposedRenderer || !onFrame || embedded) return;
    hostClearTimeout(prepaintTimer);
    prepaintTimer = hostSetTimeout(() => {
      prepaintTimer = null;
      const width = Math.max(1, Math.floor(page.width));
      const height = Math.max(1, Math.floor(page.height));
      // The visible page already has pixels. Let loading and queued layout/
      // paint settle before spending time expanding a speculative tile.
      // Retry even if that work proves to be a no-op and never calls render.
      // A stalled load backs off to one cheap check per second; a new paint
      // or scroll resets the usual 30ms delay. Scrolling outside the tile
      // still paints at that delay, using the current layout if necessary.
      if ((page.loading || page.dirty || page.needsPaint || frameTimer)
        && tileCovers(lastTile, { x: viewport.x, y: viewport.y, width, height })) {
        schedulePrepaint(Math.min(1000, Math.max(100, delay * 2)));
        return;
      }
      // Still covered with a quarter viewport to spare in both directions
      // (as far as the page goes).
      const top = Math.max(0, viewport.y - height / 4);
      const bottom = Math.max(viewport.y + height, Math.min(viewport.contentHeight, viewport.y + height * 1.25));
      if (tileCovers(lastTile, { x: viewport.x, y: top, width, height: bottom - top }) && sameRasterInput()) return;
      publish(rasterTile(prepaintRegion()));
    }, delay);
  }

  /** A rendering opportunity for DOM changes nobody has asked to see yet. */
  function scheduleFrame() {
    if (disposedRenderer || !onFrame || frameTimer || page.loading) return;
    frameTimer = hostSetTimeout(() => {
      frameTimer = null;
      refresh();
    // Coalesce ordinary mutations for the configured minimum interval.
    // Expensive style/layout rebuilds retain a longer idle window so related script mutations can settle
    // instead of continuously rebuilding a large document.
    }, Math.max(renderMinInterval, lastRebuildMs * 2));
  }

  /** The viewport as an encoded image (base64), cut from the latest tile. */
  async function viewportPng({ format = "png", quality = 80, optimizeForSpeed = false, clip } = {}) {
    if (!lastTile) return "";
    if (format === 'rgba' || format === 'bgra') {
      const {pixels,width,height} = captureViewport(lastTile, viewport.x, viewport.y, page.width, page.height,clip);
      return rawFrame(pixels,width,height,format);
    }
    const key = `${tileSerial}:${viewport.x}:${viewport.y}:${page.width}:${page.height}:${format}:${quality}:${optimizeForSpeed}:${JSON.stringify(clip)}`;
    return captures.get(key, () => {
      const { pixels, width, height } = captureViewport(lastTile, viewport.x, viewport.y, page.width, page.height,clip);
      return encodeImageBase64(pixels, width, height, { format, quality, optimizeForSpeed });
    });
  }

  /** Rasterizes display items intersecting the viewport onto a CanvasKit canvas. */
  const paintFailures = new Set();

  function paintDisplayList(canvas, displayList, view, scale, videoOverride = null, dirtyView = view) {
    if (!displayList) return;
    const pixel = (value) => Math.round(value * scale);
    const deviceRect = (rect) => CanvasKit.XYWHRect(
      pixel(rect.x - view.x), pixel(rect.y - view.y), pixel(rect.width), pixel(rect.height),
    );
    const deviceRRect = (rect, radii) => radii && (radii.x > 0 || radii.y > 0)
      ? roundedRect(deviceRect(rect), radii, scale)
      : null;
    // Returns a paint plus a release function that also frees its shader.
    const fillPaint = (item) => {
      const paint = new CanvasKit.Paint();
      if (item.radii && (item.radii.x > 0 || item.radii.y > 0)) paint.setAntiAlias(true);
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
    const paintItems = videoOverride && dirtyView !== view
      ? videoMaskItems(displayList, view, dirtyView, viewport)
      : visibleItems(displayList, dirtyView, viewport);
    for (const item of paintItems) {
      const saved = item.fixed || item.clipRect || item.opacity < 1 || item.transform ? canvas.save() : null;
      try {
        if (item.fixed) canvas.translate(viewport.x * scale, viewport.y * scale);
        if (item.clipRect) canvas.clipRect(deviceRect(item.clipRect), CanvasKit.ClipOp.Intersect, true);
        for (const clip of item.roundedClips ?? []) {
          canvas.clipRRect(deviceRRect(clip.rect, clip.radii), CanvasKit.ClipOp.Intersect, true);
        }
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
        if (videoOverride?.resource === resource) {
          paint.setColor(CanvasKit.Color(videoOverride.white ? 255 : 0, videoOverride.white ? 255 : 0, videoOverride.white ? 255 : 0, 1));
          canvas.drawRect(rect, paint);
        } else if (resource?.image) {
          canvas.drawImageRect(resource.image,
            CanvasKit.XYWHRect(0, 0, resource.bitmapWidth ?? resource.width, resource.bitmapHeight ?? resource.height),
            rect, null, false);
        }
        const centerX = rect[0] + (rect[2] - rect[0]) / 2;
        const centerY = rect[1] + (rect[3] - rect[1]) / 2;
        paint.setColor(CanvasKit.Color(0, 0, 0, 0.65));
        if (item.controls && !resource?.playing) {
          canvas.drawCircle(centerX, centerY, 22 * scale, paint);
          paint.setColor(CanvasKit.Color(255, 255, 255, 1));
          const path = CanvasKit.Path.MakeFromSVGString(
            `M ${centerX - 6 * scale} ${centerY - 10 * scale} L ${centerX + 11 * scale} ${centerY} L ${centerX - 6 * scale} ${centerY + 10 * scale} Z`);
          if (path) { canvas.drawPath(path, paint); path.delete(); }
        }
        // The control bar (play/pause, time, seekable progress) once playing or known.
        if (item.controls && (resource?.playing || Number.isFinite(resource?.duration))) {
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
        const entry = paragraphForPaint(item, scale, pixel(Math.max(1, item.textWidth + 1)));
        try {
          if (item.gradient) {
            // background-clip:text: draw glyphs, then keep the gradient only where they are.
            canvas.saveLayer(null, deviceRect(item.bounds));
            canvas.drawParagraph(entry.paragraph, pixel(item.x - view.x), pixel(item.y - view.y));
            const paint = fillPaint(item);
            paint.setBlendMode(CanvasKit.BlendMode.SrcIn);
            canvas.drawRect(deviceRect(item.bounds), paint);
            paint.release();
            canvas.restore();
          } else {
            canvas.drawParagraph(entry.paragraph, pixel(item.x - view.x), pixel(item.y - view.y));
          }
          const selected=selectedTextRange(item);
          if(selected){
            const boxes=entry.paragraph.getRectsForRange(selected.from,selected.to,CanvasKit.RectHeightStyle.Max,CanvasKit.RectWidthStyle.Tight);
            const white=paragraphForPaint({...item,color:'rgba(255, 255, 255, 1)',gradient:null},scale,pixel(Math.max(1,item.textWidth+1)));
            const paint=new CanvasKit.Paint();paint.setColor(canvasColor(CanvasKit,'rgba(56, 116, 242, 1)'));
            try{for(const box of boxes){
              const r=box.rect,ox=pixel(item.x-view.x),oy=pixel(item.y-view.y);
              const rect=CanvasKit.LTRBRect(r[0]+ox,r[1]+oy,r[2]+ox,r[3]+oy);
              canvas.save();canvas.clipRect(rect,CanvasKit.ClipOp.Intersect,false);canvas.drawRect(rect,paint);canvas.drawParagraph(white.paragraph,ox,oy);canvas.restore();
            }}finally{paint.delete();if(!white.retained)white.paragraph.delete();}
          }
        } finally {
          if (!entry.retained) entry.paragraph.delete();
        }
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
    const [x0, y0, x1, y1] = [X0 + left, Y0 + top, Math.max(X0 + left, X1 - right), Math.max(Y0 + top, Y1 - bottom)];
    const outer = roundedRect([X0, Y0, X1, Y1], item.radii, scale);
    const inner = roundedRect([x0, y0, x1, y1], insetRadii(item.radii, item.widths), scale);
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

  function nativeControlState(element) {
    return [element.value, element.checked, element.indeterminate, element.selected, element.selectedIndex];
  }

  /** HTML activation can change control properties without attribute records
   * (including a different radio in the same group). Compare these few native
   * states instead of restyling the entire document for every pointer click.
   */
  function controlStatesBeforeActivation() {
    return new Map(Array.from(page.document.querySelectorAll("input,select,textarea,option"),
      element => [element,nativeControlState(element)]));
  }

  function invalidateActivatedControls(previous) {
    for (const [element,before] of previous) {
      const after = nativeControlState(element);
      if (before.some((value,index) => value !== after[index])) {
        markStyleDirty(element);
        page.dirty = true;
      }
    }
  }

  function observeStyleChanges(document) {
    styleChanges.observer?.disconnect();
    styleChanges.records = [];
    styleChanges.roots = new Set();
    styleChanges.rootFeatures = new Map();
    styleChanges.full = "new document";
    styleChanges.activeElement = null;
    styleChanges.focusAncestors = new Set();
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
      observedAttributes: union("observedAttributes"),
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

    // Video controls are read from the live DOM when building the display
    // list. Their presence changes paint even when layout input is identical.
    if (records.some(record => record.type === "attributes" && record.attributeName === "controls"
      && record.target?.tagName === "VIDEO")) {
      page.resourcePaintDirty = true;
      page.needsPaint = true;
    }

    // qml handle begin: QML visual attributes invalidate retained rendering
    if (hasQmlDomImages(page.document) && qmlTextureVisibilityChanged(records)) {
      page.resourcePaintDirty = true;
      page.needsPaint = true;
    }
    // qml handle end

    const roots = styleChanges.roots;
    // Explicit roots mean that state-dependent selectors may need restyling;
    // they do not by themselves change render-tree content. DOM mutation
    // records below identify structural/content changes separately.
    let treeDirty = false;
    let full = styleChanges.full;
    const active = page.document.activeElement;
    const previousActive = styleChanges.activeElement;
    const previousFocusAncestors = styleChanges.focusAncestors;
    const focusAncestors = new Set();
    for (let element = active; element; element = element.parentElement) focusAncestors.add(element);
    styleChanges.activeElement = active;
    styleChanges.focusAncestors = focusAncestors;
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
        && entry.required.every((feature) => available.has(feature))
        && entry.alternatives.every(group => group.some(required => required.every(feature => available.has(feature)))));
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
    // Only the explicitly marked roots need converting to feature changes;
    // roots added by relational/focus invalidation below must remain roots.
    const markedRoots = [...roots];
    roots.clear();
    for (const element of markedRoots) {
      if (!full) changed(element, styleChanges.rootFeatures.get(element) ?? [":state"]);
    }
    if (!full) {
      // Focus affects the two subjects, their :focus-within ancestor paths,
      // and selectors related to those nodes. Keep the previous path because
      // the old focused element may have been removed or reparented already.
      if (active !== previousActive) {
        if (previousActive) changed(previousActive, [":focus", ":focus-visible"]);
        if (active) changed(active, [":focus", ":focus-visible"]);
      }
      for (const element of previousFocusAncestors) if (!focusAncestors.has(element)) changed(element, [":focus-within"]);
      for (const element of focusAncestors) if (!previousFocusAncestors.has(element)) changed(element, [":focus-within"]);
    }
    for (const record of records) {
      if (full) break;
      const target = record.target;
      if (record.type === "attributes") {
        if (target.nodeType !== 1) continue;
        const name = record.attributeName;
        // Happy DOM reports null for an empty attribute's previous value on
        // removal. Null therefore cannot prove that the attribute is unchanged.
        if (record.oldValue !== null && record.oldValue === target.getAttribute(name)) continue;
        // data/ARIA/title changes have no direct render-tree representation;
        // selectors that observe them are handled by the style diff below.
        // Other attributes may alter controls, replaced elements or visibility.
        if (!name.startsWith("data-") && !name.startsWith("aria-") && name !== "title") treeDirty = true;
        else if (!traits.observedAttributes.has(name.toLowerCase())) continue;
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
        // The UA disclosure marker depends on its parent's open state even
        // when no author selector observes [open].
        if (name === "open" && target.tagName === "DETAILS") {
          const summary = [...target.children].find(element => element.tagName === "SUMMARY");
          if (summary) self.add(summary);
        }
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
        // Adding, removing or moving a summary can change which one receives
        // the UA list-item display and disclosure marker.
        if (target.tagName === "DETAILS") {
          for (const child of target.children) if (child.tagName === "SUMMARY") self.add(child);
        }
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
    if (page.document) loadImageResource.cancelDocument(page.document);
    resourceElements?.dispose();
    resetInputCaret();
    rasterReadback.dispose();
    clearPaintParagraphs();
    resetDocumentFonts();
    disposeFrames();
    closePiano();
    disposeVideos();
    // qml handle begin: dispose application resources with their document
    page.document?.__qmlHost?.dispose();
    // qml handle end
    page.realm?.dispose();
    page.realm = null;
    page.window?.happyDOM?.close?.();
    for (const image of page.decodedImages) image.delete();
    disposeBackgrounds();
    page.window = parsed.window;
    pointerButtons = 0; suppressPointerMouse = false; pointerPresses.clear(); selectionDrag=null;
    page.document = parsed.document;
    resourceElements = createResourceElements(parsed.document);
    computedSheets = null;
    computedEnvironment = null;
    styleLayoutPending = false;
    observeDocumentCanvases(parsed.document, (node) => {
      if (disposedRenderer || node.ownerDocument !== page.document || !node.isConnected) return;
      page.resourcePaintDirty = true;
      page.needsPaint = true;
      scheduleFrame();
    });
    observeStyleChanges(parsed.document);
    page.title = parsed.document.title;
    page.styleSheets = styleSheets;
    page.linkSheets = linkSheets;
    page.resources = imageResources.map;
    initializeVideos(parsed.document, page.resources);
    page.decodedImages = imageResources.decoded;
    page.imageElements = new Set(imageResources.entries.map(entry => entry.element));
    page.resourcePaintDirty = false;
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
  function styleAndLayout(styleOnly = false) {
    const started = hostPerformance.now();
    const ms = (from, to) => Math.round(to - from);
    const sheets = currentStyleSheets();
    const environment = { width: page.width, height: page.height, mobile };
    const documentBaseURL = page.document.baseURI || page.url;
    const environmentKey = `${page.width}/${page.height}/${mobile}/${documentBaseURL}`;
    if (fontSheets !== sheets || fontEnvironment !== environmentKey) {
      fontSheets = sheets;
      fontEnvironment = environmentKey;
      fontDefinitions = sheets.flatMap(sheet => /@font-face\b/i.test(sheet) ? extractFontFaces(sheet, documentBaseURL, environment) : []);
      documentFonts.setFaces(fontDefinitions);
      const key = JSON.stringify(fontDefinitions);
      if (key !== fontDefinitionKey) {
        fontDefinitionKey = key;
        clearFontCaches();
        // Editing/removing a face can select another loaded face or fallback
        // without a font-load callback. Its metrics invalidate the same caches.
        layoutEngine = new LayoutEngine({ measureText, fontMetrics });
        if (styleEngine.usesFontMetrics) styleChanges.full = true;
        page.resourceLayoutDirty = true;
      }
    }
    const changes = takeStyleChanges(sheets); // drained even when unused, so records do not pile up
    const taken = hostPerformance.now();
    if (styleOnly && computedSheets === sheets && computedEnvironment === environmentKey
      && changes && changes.roots.size === 0 && changes.self.size === 0) {
      // Resource/geometry invalidation does not itself invalidate computed CSS.
      styleLayoutPending ||= changes.treeDirty;
      return { style: Math.round(taken - started), layout: 0, skipped: true };
    }
    // A rendering opportunity can be scheduled by lifecycle work which did
    // not actually change DOM, state, resources, or styles. Keep the retained
    // layout/display list in that case instead of laying the whole page out.
    if (!styleOnly && !styleLayoutPending && page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets && changes
      && changes.roots.size === 0 && changes.self.size === 0) {
      lastStyleParts = `changes ${Math.round(taken - started)}, no invalidation`;
      return { style: Math.round(taken - started), layout: 0, skipped: true, geometryUnchanged: true };
    }
    styleEngine.compute(page.document, sheets, environment, fullStyle ? null : changes?.roots ?? null, changes?.self ?? null);
    computedSheets = sheets;
    computedEnvironment = environmentKey;
    const computed = hostPerformance.now();
    if (!hasState || hasStateStale) {
      recordHasState(selectorTraitsFor(sheets));
      hasStateStale = false;
    }
    const recorded = hostPerformance.now();
    if (styleOnly) {
      styleLayoutPending ||= !changes || changes.treeDirty || !styleEngine.incremental || styleEngine.restyled !== 0;
      if (verifyStyle && styleEngine.incremental) verifyIncrementalStyle(sheets, environment);
      return { style: Math.round(recorded - started), layout: 0 };
    }
    // Attribute mutations used by application bookkeeping often match no
    // different rule and do not alter render-tree content. Once style has
    // proved that no element changed, retain layout and paint unchanged.
    if (!styleLayoutPending && page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets && changes
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
        ignoreStyles: !styleLayoutPending && styleEngine.incremental && styleEngine.restyled === 0,
      })) {
      styleLayoutPending = false;
      lastStyleParts += ", unchanged layout input";
      return { style: Math.round(styled - started), layout: 0, skipped: true };
    }
    // Paint-only updates such as progress-bar scaling must not reflow the
    // entire document whenever a script reads geometry.
    const repainted = page.renderTree && !page.resourceLayoutDirty && sheets === laidOutSheets
      ? repaintLayout(page.layout, page.renderTree, nextRenderTree) : null;
    page.renderTree = nextRenderTree;
    styleLayoutPending = false;
    if (repainted) {
      page.layout = repainted;
      page.displayList = paintList();
      page.resourcePaintDirty = false;
      if (clampElementScroll()) page.displayList = paintList();
      setContentSize();
      lastStyleParts += ", retained geometry";
      return { style: Math.round(styled - started), layout: 0 };
    }
    page.layout = layoutEngine.layout(page.renderTree, {
      measureText, fontMetrics, width: page.width, viewportHeight: page.height, x: 0, y: 0,
    });
    page.displayList = paintList();
    page.resourcePaintDirty = false;
    // The content may now reach less far than a container was scrolled.
    if (clampElementScroll()) page.displayList = paintList();
    page.resourceLayoutDirty = false;
    laidOutSheets = sheets;
    setContentSize();
    queueFontLoads();
    return { style: Math.round(styled - started), layout: Math.round(hostPerformance.now() - styled) };
  }

  /** BUNINU_VERIFY_STYLE: compare an incremental restyle with a full one, element by element. */
  function verifyIncrementalStyle(sheets, environment) {
    const reference = new StyleEngine({ measureText }).compute(page.document, sheets, environment);
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
    // Metadata-only flushes retain the same boxes and styles. Advancing the
    // version would make every Resize/IntersectionObserver measure again.
    // Other skipped paths remain conservative; viewport/DPR changes are also
    // passed separately to layoutChanged, even when this version is unchanged.
    if (!timing.geometryUnchanged) page.layoutVersion++;
    if (staleImages.length) {
      const stale = new Set(staleImages);
      page.decodedImages = page.decodedImages.filter(image => !stale.has(image));
      for (const image of stale) image.delete();
    }
    if (!timing.skipped) page.needsPaint = true;
    syncFrames();
    page.realm?.layoutChanged(page.layoutVersion);
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
    if (disposedRenderer) return Promise.reject(new Error("Renderer has been disposed"));
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
    url, source = "", contentType = "text/html", status = 200, statusText = "", error = null, cookie = "", cookieState = null, referrer = "",
  }, generation, commit) {
    const current = () => generation === loadGeneration;
    const finish = () => {
      page.loading = false;
      onLifecycle?.("DOMContentLoaded", generation);
      onLifecycle?.("load", generation);
    };
    // qml handle begin: optional local Qt font directory, never inherited by HTML
    const selectedFonts = page.scripting === "host" && url.startsWith("file:") && isQmlDocument(url, contentType)
      ? await loadQmlFonts(standardFonts, message => reportError(new Error(message))) : standardFonts;
    if (!current()) return;
    if (fontCollection !== selectedFonts.fontCollection) {
      ({loadedFamilies, fontCollection, fontFamilies, builtinTypefaces} = selectedFonts);
      clearFontCaches();
    }
    // qml handle end

    page.url = url;
    if (!documentCookies.accept(cookieState)) documentCookies.seed(cookieUrl(), cookie, !embedded);
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

    let isHtml = contentType.toLowerCase().includes("html");
    let parsed;

    // qml handle begin: supply DOM before the default HTML parser
    if (isQmlDocument(url, contentType)) {
      const qmlHost = page.scripting === "host" && new URL(url).protocol === "file:" ? createQmlHost(url) : null;
      parsed = await loadQmlDocument(source, url, {scripting: page.scripting !== "off", fetchResource, importRoots:qmlHost?.importRoots});
      parsed.document.__qmlHost = qmlHost;
      if (qmlHost) enableQmlDomImages(parsed.document);
      if (!current()) {qmlHost?.dispose();return;}
      // Reuse the existing stylesheet/script/lifecycle pipeline for QML DOM.
      isHtml = true;
    }
    // qml handle end

    parsed ??= parseHTMLDocument(isHtml ? source : "<body></body>", url, referrer);
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
      // qml handle begin: only a local QML host realm receives this capability
      if (page.document.__qmlHost) page.realm.pageGlobal.__qmlHost = page.document.__qmlHost;
      // qml handle end

      // qml handle begin: QML methods/properties adapt shared media and text controls
      if(page.document.__qmlHost) {
        const host=page.document.__qmlHost;
        host.media=element=>{
          element=qmlBindings.Node.unwrap(element)??element;
          if(element?.ownerDocument!==page.document||!['VIDEO','AUDIO'].includes(element.tagName))throw Error('Invalid QML media element');
          return createQmlMediaController(element,{
            valid:e=>e.ownerDocument===page.document,state:e=>page.media.get(e),
            close:closeMedia,forget:e=>{page.media.delete(e);page.resources.delete(e);},ensure:mediaStateFor,
            load:loadMedia,seek:seekMedia,play:playMedia,pause:pauseMedia,
            snapshot:mediaState,error:mediaError,gains:qmlMediaGains,
          });
        };

        host.inputClipboard=(element,operation)=>clipboardForInput(qmlBindings.Node.unwrap(element)??element,operation,{read:()=>host.clipboardRead(),write:text=>host.clipboardWrite(text)});
        host.inputPresentation=(element,options)=>{
          element=qmlBindings.Node.unwrap(element)??element;
          if(element?.ownerDocument!==page.document)return;
          inputPresentation.set(element,Object.assign(inputPresentation.get(element)||{},options));invalidateInput();
        };
      }
      // qml handle end

      // qml handle begin: local QML fragment shader capability
      if (page.document.__qmlHost) {
        const host=page.document.__qmlHost;
        host.shader=createShaderRenderer({kit:CanvasKit,unwrap:e=>qmlBindings.Node.unwrap(e),
          valid:e=>e?.ownerDocument===page.document,
          resource:e=>e.tagName==='CANVAS'?canvasResource(e):page.resources.get(e),
          paint:paintQmlCanvas,track:fn=>host.trackResource(fn)});
      }
      // qml handle end

      await page.realm.runDocumentScripts();
      if (!current()) return;
      phase("scripts");
      page.loading = false;
      refresh();
      phase("style, layout and raster after scripts");
    } else {
      await documentFonts.ready();
      if (!current()) return;
      refresh();
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
      try { target = new URL(href, document.baseURI || documentUrl); } catch { return; }
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
    if (parsed?.document) loadImageResource.cancelDocument(parsed.document);
    parsed?.window?.happyDOM?.close?.();
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
      if (src) imageRequests.set(element, imageRequestKey(src, imageCrossOrigin(element)));
    }
    page.imagesLoaded = images.then((loaded) => {
      if (generation !== loadGeneration || document !== page.document) {
        for (const image of loaded.decoded) image.delete();
        return;
      }
      for (const { element, src, resource } of loaded.entries) {
        if (element.getAttribute("src") !== src || imageCrossOrigin(element) !== resource.crossOrigin || page.resources.get(element)) {
          resource.image.delete();
          continue;
        }
        page.resources.set(element, resource);
        page.decodedImages.push(resource.image);
        page.imageElements.add(element);
        finishImageLoad(element, src, resource, type => element.dispatchEvent(new page.window.Event(type)));
      }
      page.dirty = true;
      page.resourceLayoutDirty = true;
      scheduleFrame();
    }, () => {});
  }

  function inlineStyleSheets(document) {
    return [...document.querySelectorAll("style")]
      .filter((element) => isCssStyleSheet(element) && styleSheetMatches(element))
      .map((element) => element.textContent ?? "");
  }

  function isCssStyleSheet(element) {
    const type = element.getAttribute("type")?.trim().toLowerCase();
    return (!type || type === "text/css") && !element.closest("noscript");
  }

  function styleSheetMatches(element) {
    return mediaQueryMatches(element.getAttribute("media") ?? "", { width: page.width, height: page.height, mobile })
      && !(element.tagName === "LINK" && element.hasAttribute("disabled"));
  }

  /** Brings style, layout and raster up to date; returns whether it repainted. */
  function refresh() {
    if (disposedRenderer) return false;
    syncInputCaret();
    if (page.dirty) rebuildRenderTree();
    if(followCaret) { followCaret=false; revealInputCaret(); }
    if (!page.needsPaint) return false;
    render();
    return true;
  }

  function isDisclosureControl(element) {
    if (element?.tagName === "DETAILS") return ![...element.children].some(child => child.tagName === "SUMMARY");
    return element?.tagName === "SUMMARY" && element.parentElement?.tagName === "DETAILS"
      && [...element.parentElement.children].find(child => child.tagName === "SUMMARY") === element;
  }

  function activateDisclosure(element) {
    const prevented = page.realm.dispatch(element, new page.window.MouseEvent("click", {
      bubbles: true, cancelable: true, composed: true, detail: 0,
    }));
    // An explicit summary is activated by the DOM's click default action.
    // The generated label has no DOM summary, so its owner toggles here.
    if (!prevented && element.tagName === "DETAILS") element.open = !element.open;
  }

  // qml handle begin: optional per-player PCM gain
  const qmlMediaGains=new WeakMap();
  // qml handle end

  let caretElement, caretKey, caretTimer, followCaret=false;
  function resetInputCaret() {
    hostClearInterval(caretTimer);caretTimer=null;caretElement=null;caretKey=null;
  }
  function invalidateInput() {
    page.resourceLayoutDirty=true;page.dirty=true;page.needsPaint=true;scheduleFrame();
  }
  function syncInputCaret() {
    const element=page.document?.activeElement;
    const valid=isTextInput(element)&&element.isConnected;
    const key=valid?`${element.selectionStart}:${element.selectionEnd}:${element.value}:${inputPresentation.get(element)?.visible}`:'';
    if(element===caretElement&&key===caretKey)return;
    resetInputCaret();caretElement=element;caretKey=key;followCaret=true;
    if(!valid)return;
    const options=inputPresentation.get(element)||{};options.on=true;inputPresentation.set(element,options);
    page.resourceLayoutDirty=true;page.dirty=true;page.needsPaint=true;
    if(element.selectionStart!==element.selectionEnd||options.visible===false)return;
    caretTimer=hostSetInterval(()=>{
      if(page.document?.activeElement!==element||!element.isConnected){resetInputCaret();invalidateInput();return;}
      options.on=!options.on;invalidateInput();
    },500);
    caretTimer.unref?.();
  }
  function revealInputCaret() {
    const element=page.document?.activeElement;
    if(!isTextInput(element))return;
    const position=element.selectionDirection==='backward'?element.selectionStart:element.selectionEnd;
    if(position===0){setElementScroll(element,0,0);return;}
    const caret=layoutBoxOf(inputCaretNode(element)),field=layoutBoxOf(element),geometry=scrollerGeometry(element);
    if(!caret||!field||!geometry)return;
    const [top,, ,left]=field.node.style.borderWidths||[0,0,0,0];
    const padding=field.node.style.padding||[0,0,0,0];
    const x=caret.box.x-field.box.x-left,y=caret.box.y-field.box.y-top;
    const px=Number(padding[3])||0,py=Number(padding[0])||0;
    let sx=geometry.x,sy=geometry.y;
    if(x<sx+px)sx=x-px;
    else if(x+1>sx+geometry.clientWidth-px)sx=x+1-geometry.clientWidth+px;
    if(y<sy+py)sy=y-py;
    else if(y+caret.box.height>sy+geometry.clientHeight-py)sy=y+caret.box.height-geometry.clientHeight+py;
    setElementScroll(element,sx,sy);
  }

  // Hit the same laid-out/shaped runs that paint the control. This is only
  // performed on a pointer press, never on the animation/capture path.
  function inputPositionAtPoint(element,x,y) {
    if(!String(element.value??''))return 0;
    let best=null;
    for(const hit of page.displayList?.hits??[]) {
      const run=hit.textRun;if(!run)continue;
      const node=page.renderTree.nodesById.get(hit.nodeId);
      if((inputOwner.get(node?.domNode)??node?.domNode)!==element)continue;
      let px=x+(hit.fixed?0:viewport.x),py=y+(hit.fixed?0:viewport.y);
      if(hit.transform){
        const {a,d,e,f}=hit.transform;if(!a||!d)continue;
        px=(px-e)/a;py=(py-f)/d;
      }
      const top=run.y, height=parseFloat(run.style.lineHeight)||parseFloat(run.style.fontSize)||16;
      const dy=Math.max(top-py,py-top-height,0),dx=Math.max(run.x-px,px-run.x-run.width,0);
      if(!best||dy<best.dy||dy===best.dy&&dx<best.dx)best={run,node,px,dy,dx};
    }
    if(!best)return 0;
    const {run,node,px}=best;
    const paragraph=makeParagraph(run.text,run.style);let at;
    try{
      paragraph.layout(Math.max(1,run.width+1));
      at=paragraph.getGlyphPositionAtCoordinate(px-run.x,0).pos;
    }finally{paragraph.delete();}
    let position=(node.valueStart??0)+(run.sourceStart??0)+at;
    if(element.type==='password')position=[...String(element.value)].slice(0,position).join('').length;
    return Math.max(0,Math.min(String(element.value).length,position));
  }

  function selectableText(node){
    for(let el=node.parentElement;el;el=el.parentElement){
      const value=styleEngine.get(el)?.userSelect;
      if(value==='none')return false;
      if(value==='text'||value==='all')return true;
    }
    return true;
  }
  function documentTextPoint(x,y,target=null) {
    let best=null;
    for(const hit of page.displayList?.hits??[]){
      const run=hit.textRun,node=page.renderTree.nodesById.get(hit.nodeId)?.domNode;
      if(!run||node?.nodeType!==3||!node.isConnected||!selectableText(node))continue;
      if(target && !target.contains(node))continue;
      if(node.parentElement?.closest('button,input,textarea,select,canvas,script,style'))continue;
      let px=x+(hit.fixed?0:viewport.x),py=y+(hit.fixed?0:viewport.y);
      if(hit.transform){const {a,d,e,f}=hit.transform;if(!a||!d)continue;px=(px-e)/a;py=(py-f)/d;}
      if(hit.clipRect && (px<hit.clipRect.x||py<hit.clipRect.y||px>hit.clipRect.x+hit.clipRect.width||py>hit.clipRect.y+hit.clipRect.height))continue;
      const height=parseFloat(run.style.lineHeight)||parseFloat(run.style.fontSize)||16;
      const dy=Math.max(run.y-py,py-run.y-height,0),dx=Math.max(run.x-px,px-run.x-run.width,0);
      if(!best||dy<best.dy||dy===best.dy&&dx<best.dx)best={run,node,px,dy,dx};
    }
    if(!best)return null;
    const {run,node,px}=best,p=makeParagraph(run.text,run.style);
    try{p.layout(Math.max(1,run.width+1));return {node,offset:Math.max(0,Math.min(node.textContent.length,(run.sourceStart??0)+p.getGlyphPositionAtCoordinate(px-run.x,0).pos))};}
    finally{p.delete();}
  }
  function extendDrag(x,y){
    if(selectionDrag.element){
      const el=selectionDrag.element;if(!el.isConnected||page.document.activeElement!==el){selectionDrag=null;return;}
      selectInput(el,selectionDrag.anchor,inputPositionAtPoint(el,x,y));syncInputCaret();invalidateInput();
    }else{
      const point=documentTextPoint(x,y);if(!point||!selectionDrag.node.isConnected)return;
      page.window.getSelection().setBaseAndExtent(selectionDrag.node,selectionDrag.offset,point.node,point.offset);
      selectionVersion++;
      page.needsPaint=true;
    }
  }
  function selectedTextRange(item){
    const sel=page.window.getSelection(),node=page.renderTree.nodesById.get(item.nodeId)?.domNode;
    if(!sel?.rangeCount||sel.isCollapsed||node?.nodeType!==3||!node.isConnected||!selectableText(node))return null;
    const range=sel.getRangeAt(0);if(!range.intersectsNode(node))return null;
    const base=item.sourceStart??0;
    const from=Math.max(0,(range.startContainer===node?range.startOffset:0)-base);
    const to=Math.min(item.text.length,(range.endContainer===node?range.endOffset:node.textContent.length)-base);
    return to>from?{from,to}:null;
  }

  function clipboardForInput(element,operation,backend={read:clipboardReadInput,write:clipboardWriteInput}) {
    return inputClipboard(element,operation,{...backend,replace:(text,type)=>{
      if(page.document.activeElement!==element)return;
      editFocusedText(text,false,type);syncInputCaret();invalidateInput();
    }});
  }
  function inputDefault(element,event) {
    if(!isTextInput(element)||event.altKey)return false;
    if(moveInputSelection(element,event)){syncInputCaret();invalidateInput();return true;}
    if((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(event.key.toLowerCase())) {
      let backend;

      // qml handle begin: local applications choose their frontend clipboard transport
      const host=page.document.__qmlHost;
      if(host)backend={read:()=>host.clipboardRead(),write:text=>host.clipboardWrite(text)};
      // qml handle end

      clipboardForInput(element,{c:'copy',x:'cut',v:'paste'}[event.key.toLowerCase()],backend).catch(reportError);
      return true;
    }
    if(event.key==='Delete'&&!element.readOnly) {
      const at=element.selectionStart;
      if(at===element.selectionEnd)selectInput(element,at,at+(String(element.value).codePointAt(at)>0xffff?2:1));
      editFocusedText('',false,'deleteContentForward');invalidateInput();return true;
    }
    return false;
  }

  function editFocusedText(text, backspace = false, inputType = 'insertText') {
    const element = page.document.activeElement;
    if (!element || !["INPUT", "TEXTAREA"].includes(element.tagName) || element.disabled || element.readOnly) return;
    if (element.tagName === "INPUT" && !["text", "search", "url", "email", "tel", "password"].includes(element.type)) return;
    // Mobile IMEs often send committed text without a usable keydown (key 229
    // or Unidentified). Handle that before the normal beforeinput insertion.
    if (!backspace && handlePianoInput(element, { text }, audio ? playPiano : null)) return;
    const value = String(element.value ?? "");
    let start = Number.isInteger(element.selectionStart) ? element.selectionStart : value.length;
    const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start;
    if (backspace && start === end && start > 0) start = [...value.slice(0, start)].slice(0, -1).join("").length;
    if (backspace && start === end) return;
    if (page.realm) {
      const prevented = page.realm.dispatch(element, new page.window.InputEvent("beforeinput", {
        bubbles: true, cancelable: true, data: backspace ? null : text,
        inputType: backspace ? "deleteContentBackward" : inputType,
      }));
      if (prevented) return;
    }
    element.value = value.slice(0, start) + text + value.slice(end);
    markStyleDirty(element); // :placeholder-shown, :valid / :invalid
    element.setSelectionRange?.(start + text.length, start + text.length);
    if (page.realm) page.realm.dispatch(element, new page.window.InputEvent("input", { bubbles: true, inputType:backspace?"deleteContentBackward":inputType, data:backspace?null:text }));
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
      activationState: controlStatesBeforeActivation,
      activationChanged(previous) {
        invalidateActivatedControls(previous);
        if (page.dirty) scheduleFrame();
      },
      canvasImage(element) {
        if (!element) return null;
        if (element.tagName === "CANVAS") return canvasResource(element);

        // qml handle begin: local QML may draw a DOM subtree into a canvas
        if (hasQmlDomImages(page.document) && !["IMG", "VIDEO", "AUDIO", "IMAGE"].includes(element.tagName)) {
          if (page.dirty) rebuildRenderTree();
          return captureQmlDomImage(element, {
            document: page.document, tree: page.renderTree, layout: page.layout,
            resources: page.resources, backgroundResource, scrollOffsetOf,
            kit: CanvasKit, paint: paintDisplayList, canvasResource,
            isOriginClean: resource => resource?.originClean ?? Boolean(resource?.url &&
              (resource.url.startsWith("data:") || originOf(resource.url) === originOf(page.url))),
          });
        }
        // qml handle end

        const resource = page.resources.get(element);
        if (!resource?.image) return null;
        const url = resource.url ?? element.src ?? "";
        const originClean = resource.originClean ?? (url.startsWith("data:") || originOf(url) === originOf(page.url));
        return { ...resource, originClean };
      },
      canvasFont(element, value) {
        if (page.dirty) styleAndLayout(true);
        return parseCanvasFont(value, styleEngine.get(element)?.fontSize ?? 16,
          styleEngine.get(page.document.documentElement)?.fontSize ?? 16);
      },
      canvasText(element, request) {
        if (request.settings.direction === "inherit" && page.dirty) styleAndLayout(true);
        const style = { ...request.settings.parsedFont,
          direction: request.settings.direction === "inherit" ? styleEngine.get(element)?.direction ?? "ltr" : request.settings.direction };
        documentFonts.update(fontDefinitions, [{ text: String(request.args[0]), style }]);
        return renderCanvasText({ ...request, style,
          settings: { ...request.settings, direction: style.direction } });
      },
      mediaState,
      playMedia,
      pauseMedia,
      seekMedia,
      reselectMedia,
      attachMediaSrc,
      mediaReadyState,
      mediaNetworkState,
      mediaError,
      mediaBuffered,
      mediaAppended,
      mediaDuration,
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
      whenImagesLoaded: () => Promise.all([page.imagesLoaded, documentFonts.ready(), ...[...page.backgrounds.values()].map((entry) => entry.loaded)]),
      selectionChanged(){selectionVersion++;page.needsPaint=true;scheduleFrame();},
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
      scrollIntoView(element, options) {
        if (page.dirty) rebuildRenderTree("script scrolled");
        revealElement(element, options);
      },
      computedStyle(element, needsLayout = true) {
        if (!element) return null;
        if (page.dirty) {
          if (needsLayout) rebuildRenderTree("getComputedStyle");
          else styleAndLayout(true);
        }
        const style = styleEngine.get(element);
        if (needsLayout && style?.padding.some(value => typeof value === "object")) {
          const box = page.layout?.boxes.find(box => page.renderTree.nodesById.get(box.nodeId)?.domNode === element);
          if (box) return { ...style, padding: box.style.padding };
        }
        return style;
      },
      layoutVersion() {
        if (page.dirty) rebuildRenderTree("intersection observer");
        return page.layoutVersion;
      },
      customProperties(element, updateStyle = true) {
        if (!element) return null;
        if (updateStyle && page.dirty) styleAndLayout(true);
        return styleEngine.customPropertiesOf(element);
      },
      navigate: (url) => navigateTo(String(url)),
      activateLink(anchor) {
        const href = new URL(anchor.getAttribute("href"), anchor.baseURI || page.url).href;
        const name = anchor.hasAttribute("download") ? anchor.getAttribute("download") ?? "" : null;
        if (href.startsWith("blob:") && name !== null) void downloadBlob(href, name);
        else navigateTo(href, name);
      },
      submitForm,
      async fetchScript(url) {
        // Blob URLs live in this document's registry. Host fetch only accepts
        // http(s) and s3, and a MediaSource URL has no script bytes.
        if (/^blob:/i.test(url)) {
          const stored = page.realm?.blobEntry?.(url);
          if (stored?.kind !== "blob") throw new TypeError("Failed to fetch");
          return new TextDecoder().decode(await stored.blob.arrayBuffer());
        }
        if (/^data:/i.test(url)) {
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
      initScripts: () => page.initScripts ?? [],
      rewriteScript,
      documentCookie: () => documentCookies.get(cookieUrl()),
      setDocumentCookie(value) {
        documentCookies.set(cookieUrl(), value);
      },
      clipboardRead,
      clipboardWrite,
      webSockets,
      pageFetch(request) {
        const generation = loadGeneration;
        const networkPending = pageFetch(request);
        const result = networkPending.then((response) => {
          if (generation === loadGeneration) acceptCookies(response);
          return response;
        });
        result.abort = (reason) => networkPending.abort?.(reason);
        result.finished = networkPending.finished;
        return result;
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
    const url = new URL(action || page.url, form.baseURI || page.url);
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
    const box = elementBox(page.renderTree, page.layout, element)?.box;
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
      const stored = page.realm?.blobEntry?.(url);
      let data;
      if (stored?.kind === "blob") data = new Uint8Array(await stored.blob.arrayBuffer());
      else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`blob download failed: HTTP ${response.status}`);
        data = new Uint8Array(await response.arrayBuffer());
      }
      if (data.byteLength > 64 * 1024 * 1024) throw new Error("blob download exceeds 64 MB");
      requestDownload({ url, name, data });
    } catch (error) {
      reportError(error);
    }
  }

  const api = {
    loadDocument,
    updateCookies: state => documentCookies.accept(state),
    /** Enables page scripts once the sandbox is ready: "ses", "host", or "off". */
    setScripting(mode) {
      page.scripting = ["ses", "host"].includes(mode) ? mode : "off";
    },
    setUserAgent(userAgent) {
      if (typeof userAgent === "string" && userAgent) page.userAgent = userAgent;
    },
    /** Scripts every new document runs before its own (CDP Page.addScriptToEvaluateOnNewDocument). */
    setInitScripts(sources) {
      page.initScripts = Array.isArray(sources) ? sources.map(String) : [];
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
      const resized = width !== page.width || height !== page.height;
      page.pageScale = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1;
      page.width = width;
      page.height = height;
      page.deviceScaleFactor = Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
        ? deviceScaleFactor
        : 1;
      viewport.resize(width, height);
      // Viewport dimensions are layout input even when DOM/stylesheets did
      // not mutate (including CSS resizes that keep the same pixel size by
      // changing DPR). Bypass retained-layout shortcuts in that case.
      if (resized) page.resourceLayoutDirty = true;
      rebuildRenderTree();
      // Listeners must observe the new viewport and layout. A repeated metrics
      // request (or DPR-only change) does not resize the CSS viewport.
      if (resized && page.realm)
        page.realm.dispatch(page.window, new page.window.Event("resize"));
      render();
    },
    screenshot(options) {
      refresh();
      return viewportPng(options);
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
      page.realm?.layoutChanged(page.layoutVersion);
      syncedScroll = { x: viewport.x, y: viewport.y };
      schedulePrepaint();
    },
    title() {
      // DOM title changes are synchronous and do not require layout or paint.
      // An empty document title is also a live value, not a cached-title fallback.
      return page.document?.title ?? page.title;
    },
    scroll(deltaX, deltaY) {
      if (viewport.scrollBy(deltaX, deltaY)) render();
      return { x: viewport.x, y: viewport.y };
    },
    press(key, options = {}) {
      if (focusedFrame?.renderer) return focusedFrame.renderer.press(key, options);
      refresh();
      const pianoInput = page.document?.activeElement;
      if (handlePianoInput(pianoInput, { ...options, key }, audio ? playPiano : null)) {
        return { x: viewport.x, y: viewport.y };
      }
      // Pages see keydown/keyup first; preventDefault() cancels the default scroll.
      if (page.realm) {
        const target = page.document.activeElement ?? page.document.body;
        const modifiers = Number(options?.modifiers) || 0;
        const init = {
          ...keyboardInput(key, options), repeat: Boolean(options?.repeat),
          altKey: Boolean(modifiers & 1), ctrlKey: Boolean(modifiers & 2),
          metaKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8),
          bubbles: true, cancelable: true,
        };
        const prevented = page.realm.dispatch(target, new page.window.KeyboardEvent("keydown", init));
        let activated = false;
        const inputHandled=!prevented&&inputDefault(target,init);
        if(!prevented&&!inputHandled&&(init.ctrlKey||init.metaKey)&&init.key.toLowerCase()==='c'){
          const text=page.window.getSelection().toString();if(text)clipboardWriteInput(text).catch(reportError);
        }
        if (!inputHandled && !prevented && !init.ctrlKey && !init.metaKey && !init.altKey) {
          if ((key === "Enter" || key === " ") && isDisclosureControl(target)) {
            activated = true;
            if (key === "Enter") activateDisclosure(target);
          }
          else if (key === "Backspace") editFocusedText("", true);
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
        const upPrevented = page.realm.dispatch(target, new page.window.KeyboardEvent("keyup", init));
        if (activated && key === " " && !upPrevented) activateDisclosure(target);
        if (refresh() || prevented || activated || inputHandled) return { x: viewport.x, y: viewport.y };
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
    videoReport(report) {
      const state = [...page.media.values()].find(state => state.video?.presentation?.id === report.id);
      if (!state || !state.playing) return;
      if (report.error) {
        state.presentationFailed = true;
        stopVideoPresentation(state);
        const serial = state.seekSerial;
        void placeVideo(state, mediaTime(state)).then(() => {
          if (state.playing && state.document === page.document && state.seekSerial === serial) startMedia(state);
        }).catch(reportError);
      } else if (Number.isSafeInteger(report.continued)) {
        const video = state.video, p = video.presentation, continuation = p.continuation;
        if (!continuation?.decoder || report.revision !== p.revision + 1 || report.continued !== continuation.generation) return;
        video.decoder.close();
        video.decoder = continuation.decoder;
        continuation.decoder = null;
        Object.assign(video, { bytes: continuation.bytes, openedGeneration: continuation.generation,
          needsLocalPosition: true, done: false });
        p.revision = report.revision;
        p.continuation = null;
        p.pendingEnd = null;
        p.exhaustedAt = null;
      } else if ((report.revision ?? 0) !== state.video.presentation.revision) return;
      else if (report.continuationError) {
        failVideoContinuation(state, state.video.presentation);
      } else if (Number.isFinite(report.exhaustedAt)) {
        state.video.presentation.exhaustedAt = report.exhaustedAt;
        continueVideoSnapshot(state, report.exhaustedAt);
      } else if (Number.isFinite(report.end)) {
        const p = state.video.presentation;
        // EOF can reach the page before its extension reaches the worker.
        // Defer that old revision's end until continuation succeeds or fails.
        if (p.continuation) p.pendingEnd = report.end;
        else if (p.exhaustedAt !== report.end || !continueVideoSnapshot(state, report.end))
          finishVideoPresentation(state, report.end);
      } else if (Number.isFinite(report.time)) state.video.shownTime = report.time;
    },
    /** The wheel at a viewport point: the delta the page itself still has to scroll (see wheel). */
    wheel(x, y, deltaX, deltaY, options = undefined) {
      return wheel(Number(x), Number(y), Number(deltaX) || 0, Number(deltaY) || 0, options);
    },
    /** Move the pointer in viewport coordinates, including boundary events. */
    move(x, y, options = {}) {
      // Hit testing needs current geometry, not a rasterized frame. Dispatch
      // every motion (drawing needs every point), but let the frame scheduler
      // combine their paints instead of rasterizing the whole page per event.
      if (page.dirty) rebuildRenderTree("pointer hit test");
      const target = elementAtPoint(page.renderTree, page.displayList, Number(x), Number(y), viewport) ?? (pointerButtons ? page.document.documentElement : null);
      const inside = target?.tagName === 'IFRAME' ? frameAt(target, x, y) : null;
      if (inside) inside.frame.renderer.move(inside.x, inside.y, options);
      dispatchPointerMove(page.window, page.realm, target, Number(x), Number(y), {...options, buttons: pointerButtons, suppressMouse:suppressPointerMouse});
      if(selectionDrag && (pointerButtons&1)) extendDrag(x,y);
      if (page.dirty || page.needsPaint) scheduleFrame();
    },
    /**
     * Clicks at a viewport point: the page receives a click event first, and
     * unless it calls preventDefault() a link under the point is returned for
     * the controller to navigate to.
     */
    pointerButton(x, y, button, state, options = {}) {
      if (button < 272 || button > 274) return null;
      return this.click(x, y, {...options, button: button === 273 ? 'right' : button === 274 ? 'middle' : 'left', phase: state ? 'down' : 'up'});
    },
    click(x, y, options = {}) {
      const detail = Number.isInteger(options.clickCount) && options.clickCount > 0 ? options.clickCount : 1;
      refresh();
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
      const hitNode = page.displayList ? renderNodeAtPoint(page.renderTree, page.displayList, x, y, viewport) : null;
      const precise = hitNode?.domNode?.nodeType === 1 ? hitNode.domNode : hitNode?.domNode?.parentElement;
      const target = options.activationTarget ?? (forwarded ? region.element : inputOwner.get(precise) ?? precise ?? region?.element ?? (options.phase ? page.document.documentElement : null));
      const generatedDisclosure = hitNode?.pseudo === "summary" && target?.tagName === "DETAILS";
      if (!target) {
        focusedFrame = null;
        return null;
      }
      // Event dispatch determines the activation target before handlers run.
      // A handler may replace the clicked descendants while retaining the link.
      const activationAnchor = target.closest?.("a[href]");
      // A click inside an iframe belongs to its document alone.
      const inFrame = target.tagName === "IFRAME" ? frameAt(target, x, y) : null;
      focusedFrame = inFrame?.frame ?? null;
      if (inFrame) {
        const followed = inFrame.frame.renderer.click(inFrame.x, inFrame.y, options);
        const href = typeof followed === "string" ? followed : followed?.fragmentFrom ? null : followed?.url;
        if (href && !followed?.download) void loadFrame(inFrame.frame, href);
        return null;
      }
      const mouseButton = options.button === 'right' || options.button === 2 ? 2
        : options.button === 'middle' || options.button === 1 ? 1 : 0;
      // The press focuses the focusable element it lands in, unless mousedown was canceled.
      const focus = () => {
        selectionDrag=null;
        const focusable = generatedDisclosure ? target : target.closest?.("input, textarea, select, button, summary, [tabindex]");
        if (focusable && !focusable.disabled) {
          const position=isTextInput(focusable)&&!forwarded?inputPositionAtPoint(focusable,x,y):null;
          focusable.focus();
          if(position!==null){selectInput(focusable,position);syncInputCaret();invalidateInput();if(options.phase==='down')selectionDrag={element:focusable,anchor:position};}
        } else if(mouseButton===0){
          const point=documentTextPoint(x,y,target);
          if(point)page.document.activeElement?.blur?.();
          selectionVersion++;page.window.getSelection().removeAllRanges();
          if(point){page.window.getSelection().collapse(point.node,point.offset);if(options.phase==='down')selectionDrag=point;}
          page.needsPaint=true;
        }
      };
      const modifiers = options.modifiers ?? 0;
      const mouseInit = { bubbles:true, cancelable:true, composed:true,
        clientX:Number(x), clientY:Number(y), button:mouseButton, detail,
        altKey:!!(modifiers&1), ctrlKey:!!(modifiers&2),
        metaKey:!!(modifiers&4), shiftKey:!!(modifiers&8) };
      if (options.phase) {
        const mask = mouseButton === 0 ? 1 : mouseButton === 1 ? 4 : 2;
        const before = pointerButtons;
        const pressed = pointerPresses.get(mouseButton);
        pointerButtons = options.phase === 'down' ? before | mask : before & ~mask;
        const Pointer = page.window.PointerEvent ?? page.window.MouseEvent;
        const pointer = {...mouseInit, detail:0, buttons:pointerButtons,
          pointerId:1, pointerType:'mouse', isPrimary:true};
        if (options.phase === 'down') {
          const record = {target, document:page.document, suppressMouse:false};
          pointerPresses.set(mouseButton, record);
          if (page.realm) {
            if (before === 0) suppressPointerMouse = page.realm.dispatch(target,new Pointer('pointerdown',pointer));
            record.suppressMouse = suppressPointerMouse;
            if (before !== 0) page.realm.dispatch(target,new Pointer('pointermove',pointer));
            if (!record.suppressMouse) {
              const prevented = page.realm.dispatch(target,new page.window.MouseEvent('mousedown',{...mouseInit,buttons:pointerButtons}));
              if (mouseButton === 0 && !prevented) focus();
            }
            if (mouseButton === 2) page.realm.dispatch(target,new Pointer('contextmenu',pointer));
          } else if (mouseButton === 0) focus();
          refresh();
          return null;
        }
        let selectedByDrag=false;
        if(mouseButton===0){
          if(selectionDrag){extendDrag(x,y);selectedByDrag=!selectionDrag?.element&&!page.window.getSelection().isCollapsed;}
          selectionDrag=null;
        }
        pointerPresses.delete(mouseButton);
        if (page.realm) {
          page.realm.dispatch(target,new Pointer(pointerButtons ? 'pointermove' : 'pointerup',pointer));
          if (!suppressPointerMouse) page.realm.dispatch(target,new page.window.MouseEvent('mouseup',{...mouseInit,buttons:pointerButtons}));
        }
        if (!pointerButtons) suppressPointerMouse = false;
        // Click/auxclick targets the common ancestor of the press and release.
        // Removed press targets and releases without a press do not activate.
        let activation = target;
        if (!pressed || pressed.document !== page.document || !pressed.target.isConnected) activation = null;
        while (activation && !activation.contains(pressed.target)) activation = activation.parentElement;
        refresh();
        return activation ? this.click(x,y,{...options,phase:undefined,activationOnly:true,activationTarget:activation,selectionDragged:selectedByDrag}) : null;
      }
      if (mouseButton !== 0) {
        // Non-primary clicks reach DOM handlers without primary activation
        // (navigation, form submission, controls, text-caret placement).
        if (page.realm) {
          const init = mouseInit;
          const Pointer = page.window.PointerEvent ?? page.window.MouseEvent;
          const pointer = {...init, detail:0, pointerId:1, pointerType:'mouse', isPrimary:true};
          const buttons = mouseButton === 2 ? 2 : 4;
          if (!options.activationOnly) {
            page.realm.dispatch(target,new Pointer('pointerdown',{...pointer,buttons}));
            page.realm.dispatch(target,new page.window.MouseEvent('mousedown',{...init,buttons}));
            if(mouseButton===2)page.realm.dispatch(target,new Pointer('contextmenu',{...pointer,buttons}));
            page.realm.dispatch(target,new Pointer('pointerup',{...pointer,buttons:0}));
            page.realm.dispatch(target,new page.window.MouseEvent('mouseup',{...init,buttons:0}));
          }
          page.realm.dispatch(target,new Pointer('auxclick',{...pointer,detail,buttons:pointerButtons}));
          refresh();
        }
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
      if (!page.realm) { if (!options.activationOnly) focus(); }
      else {
        const controlStates = controlStatesBeforeActivation();
        // A press and release, then the click (UI Events §3.5).
        const init = { ...mouseInit, buttons: pointerButtons };
        const PointerEvent = page.window.PointerEvent ?? page.window.MouseEvent;
        const pointer = { ...init, detail: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
        if (!options.activationOnly) {
          page.realm.dispatch(target, new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
          if (!page.realm.dispatch(target, new page.window.MouseEvent("mousedown", { ...init, buttons: 1 }))) focus();
          page.realm.dispatch(target, new PointerEvent("pointerup", pointer));
          page.realm.dispatch(target, new page.window.MouseEvent("mouseup", init));
        }
        const prevented = page.realm.dispatch(target, new page.window.MouseEvent("click", init));
        // dblclick follows the second click even when its default action was cancelled.
        if (detail === 2) page.realm.dispatch(target, new page.window.MouseEvent("dblclick", init));
        invalidateActivatedControls(controlStates);
        refresh();
        if (prevented) return null;
      }
      if (options.selectionDragged) return null;
      if (generatedDisclosure) {
        target.open = !target.open;
        refresh();
        return null;
      }
      if ((target.tagName === "AUDIO" || target.tagName === "VIDEO") && target.hasAttribute("controls")) {
        clickMedia(target, x, y);
        return null;
      }
      const anchor = activationAnchor;
      if (!anchor?.hasAttribute("href")) return null;
      const href = new URL(anchor.getAttribute("href"), anchor.baseURI || page.url).href;
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
        let timer;
        try {
          value = await Promise.race([
            Promise.resolve(value),
            new Promise((resolve) => { timer = hostSetTimeout(resolve, 5000, undefined); }),
          ]).catch((error) => String(error?.message ?? error));
        } finally { hostClearTimeout(timer); }
      }
      refresh();
      return cloneableResult(value);
    },
    dispose() {
      if (disposedRenderer) return;
      resetInputCaret();
      disposedRenderer = true;
      resourceElements?.dispose();
      resourceElements = null;
      loadGeneration++;
      if (page.document) loadImageResource.cancelDocument(page.document);
      hostClearTimeout(prepaintTimer);
      hostClearTimeout(frameTimer);
      disposeFrames();
      // qml handle begin: renderer shutdown closes application resources
      page.document?.__qmlHost?.dispose();
      // qml handle end
      page.realm?.dispose();
      closePiano();
      disposeVideos();
      rasterSurface?.dispose();
      rasterSurface = null;
      rasterReadback.dispose();
      clearPaintParagraphs();
      documentFonts.dispose();
      page.window?.happyDOM?.close?.();
      for (const image of page.decodedImages) image.delete();
      page.decodedImages = [];
      page.imageElements.clear();
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
    const elements = document === page.document && resourceElements
      ? resourceElements.get("sheets") : document.querySelectorAll("style, link[rel~='stylesheet']");
    for (const element of elements) {
      if (!isCssStyleSheet(element)) continue;
      const applies = styleSheetMatches(element);
      if (element.tagName === "STYLE") {
        if (applies) sheets.push(element.textContent ?? "");
        continue;
      }
      // A disabled link is fetched when enabled; nonmatching media may be
      // fetched now, but must never contribute rules to the screen cascade.
      if (element.hasAttribute("disabled")) continue;
      const href = element.getAttribute("href");
      let url;
      try { url = href ? new URL(href, element.baseURI || documentUrl).href : null; } catch { url = null; }
      if (!url) continue;
      const loaded = linkSheets.get(element);
      if (loaded?.url === url) {
        if (applies && loaded.text !== null) sheets.push(loaded.text);
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
        if (document !== page.document || linkSheets.get(element) !== entry) return;
        page.dirty = true;
        scheduleFrame();
        element.dispatchEvent(new page.window.Event(entry.text === null ? "error" : "load"));
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
      beginImageLoad(element, src);
      try {
        const resource = await loadImageResource(document, new URL(src, element.baseURI || documentUrl).href, imageCrossOrigin(element));
        finishImageLoad(element, src, resource);
        map.set(element, resource);
        decoded.push(resource.image);
        entries.push({ element, src, resource });
      } catch {
        // Broken images keep their fallback replaced-element dimensions.
        finishImageLoad(element, src, null);
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
    const elements = document ? resourceElements.get("frames") : [];
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
      renderMinInterval,
      fetchResource: rawFetchResource,
      requestNavigation: (url, downloadName) => {
        if (downloadName === null) void loadFrame(frame, url);
      },
      requestDownload,
      reportError,
      pageFetch,
      clipboardRead,
      clipboardWrite,
      clipboardReadInput,
      clipboardWriteInput,
      webSockets,
      setCookie,
      documentCookies,
      inheritedCookieUrl: cookieUrl,
      consoleMessage,
      onFrame: (update) => showFrame(frame, update),
      onLifecycle: (name, generation) => frameLifecycle(frame, name, generation),
      videoDecoder,
      rewriteScript,
      mobile,
      embedded: true,
      frameWindow: frame.window,
    }, loadedGraphics);
    // Page scripts in "host" mode share one global object; a frame's scripts need their own.
    renderer.setScripting(page.scripting === "ses" ? "ses" : "off");
    renderer.setUserAgent(page.userAgent);
    renderer.setInitScripts(page.initScripts ?? []);
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
      return new URL(src, element.baseURI || page.url).href;
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
          cookie: documentCookies.get(target.href),
          cookieState: response.cookieState,
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
    for (const node of page.renderTree?.nodesById.values() ?? []) {
      if (node.tagName !== "CANVAS") continue;
      const resource = canvasResource(node.domNode);
      if (resource) page.resources.set(node.domNode, resource);
      else page.resources.delete(node.domNode);
    }

    // qml handle begin: texture sources keep layout/input but paint through their texture
    if (hasQmlDomImages(page.document)) return filterQmlTextureSources(
      buildDisplayList(page.layout, page.renderTree, page.resources, backgroundResource, scrollOffsetOf), page.renderTree);
    // qml handle end

    return buildDisplayList(page.layout, page.renderTree, page.resources, backgroundResource, scrollOffsetOf);
  }

  function scrollOffsetOf(element) {
    return element ? page.elementScroll.get(element) ?? null : null;
  }

  /** The render node and layout box of an element, or null. */
  function layoutBoxOf(element) {
    return elementBox(page.renderTree, page.layout, element);
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
    // In-flow content gets the end padding; absolutely positioned boxes reach only as far as they do.
    const scrollWidth = Math.max(client.width, extent ? Math.max(extent.flowRight - client.x + (Number(padding[1]) || 0),
      extent.right - client.x) : 0);
    const scrollHeight = Math.max(client.height, extent ? Math.max(extent.flowBottom - client.y + (Number(padding[2]) || 0),
      extent.bottom - client.y) : 0);
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
    page.layoutVersion++;
    page.realm?.layoutChanged(page.layoutVersion);
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

  /** Aligns the element within each scrollport, from the innermost out. */
  function revealElement(element, { block = "start", inline = "nearest", container = "all" } = {}) {
    let moved = false;
    let fixed = styleEngine.get(element)?.position === "fixed";
    const direction = styleEngine.get(element)?.direction;
    if (direction === "rtl" && inline !== "nearest" && inline !== "center") inline = inline === "start" ? "end" : "start";
    for (let node = element.parentElement; !fixed && node && node.nodeType === 1; node = node.parentElement) {
      if (node === page.document.documentElement) break;
      fixed = styleEngine.get(node)?.position === "fixed";
      const geometry = scrollerGeometry(node);
      if (!geometry) continue;
      const target = viewportBounds(element);
      const bounds = viewportBounds(node);
      if (!target || !bounds) continue;
      const [borderTop, , , borderLeft] = styleEngine.get(node)?.borderWidths ?? [0, 0, 0, 0];
      moved = setElementScroll(node,
        geometry.x + scrollAlignmentDelta(target.left - bounds.left - borderLeft, target.width, geometry.clientWidth, inline),
        geometry.y + scrollAlignmentDelta(target.top - bounds.top - borderTop, target.height, geometry.clientHeight, block)) || moved;
      if (container === "nearest") { if (moved) render(); return; }
    }
    const bounds = viewportBounds(element);
    if (bounds && !fixed) moved = viewport.scrollTo(
      viewport.x + scrollAlignmentDelta(bounds.left, bounds.width, viewport.width, inline),
      viewport.y + scrollAlignmentDelta(bounds.top, bounds.height, viewport.height, block)) || moved;
    if (moved) render();
  }

  /** Every <video> and <audio> gets its (painted) resource: size, frame, playing, time. */
  function initializeVideos(document, resources) {
    const elements = document === page.document && resourceElements
      ? resourceElements.get("media") : document.querySelectorAll("video, audio");
    for (const element of elements) {
      if (resources.get(element)) continue;
      const audioOnly = element.tagName === "AUDIO";
      resources.set(element, { width: audioOnly ? 300 : Number(element.getAttribute("width")) || 300,
        height: audioOnly ? 32 : Number(element.getAttribute("height")) || 150,
        bitmapWidth: 0, bitmapHeight: 0, image: null, playing: false, time: 0, duration: NaN });
    }
  }

  function videoSource(element) {
    const src = element.getAttribute("src") ?? element.querySelector("source[src]")?.getAttribute("src");
    try { return src ? new URL(src, element.baseURI || page.url).href : null; } catch { return null; }
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
    const decoder = state?.video?.decoder;
    return { paused: !state?.playing, ended: Boolean(state?.ended), currentTime: state ? mediaTime(state) : 0,
      duration: state?.duration ?? NaN, videoWidth: decoder?.width || 0, videoHeight: decoder?.height || 0 };
  }

  function mediaReadyState(element) {
    const state = page.media.get(element);
    if (!state?.probed) return 0;
    if (state.buffering) return 2;
    if (state.video || state.sound) return state.pipe && !state.pipe.done ? 3 : 4;
    return 1;
  }

  function mediaNetworkState(element) {
    const state = page.media.get(element);
    const hasSrc = Boolean(videoSource(element) || elementSources.get(element));
    if (!state && !hasSrc) return 0;
    if (state?.error) return 3;
    if ((state?.pipe && !state.pipe.done) || state?.loading) return 2;
    return 1;
  }

  function mediaError(element) {
    return page.media.get(element)?.error ?? null;
  }

  function mediaBuffered(element) {
    const state = page.media.get(element);
    const end = state?.mediaSource?.bufferedEnd?.() || state?.bufferedEnd || 0;
    return end > 0 ? { length: 1, start: 0, end } : { length: 0, start: 0, end: 0 };
  }

  function resolveMediaSource(value) {
    const realm = page.realm;
    if (!realm?.isMediaSource) return null;
    if (realm.isMediaSource(value)) return value;
    if (typeof value === "string") return realm.mediaSourceAt(value);
    return null;
  }

  function selectedMediaInput(element) {
    return elementSourceObjects.get(element) ?? element.getAttribute("src")
      ?? element.querySelector("source[src]")?.getAttribute("src") ?? null;
  }

  function selectedMediaSource(element, reselect = false) {
    const input = selectedMediaInput(element);
    const state = page.media.get(element);
    // A selected resource outlives object-URL revocation or a <base> change.
    // Explicit src assignment or load() selects again, even when raw src is
    // unchanged; passive metadata/playback must keep its original selection.
    if (!reselect && state?.input === input) return { input, source: state.mediaSource, url: state.url };
    const source = resolveMediaSource(typeof input === "string" ? videoSource(element) : input);
    return { input, source, url: typeof input === "string" ? videoSource(element) : source?._objectURL ?? null };
  }

  function linkMediaSource(element, source) {
    const previous = elementSources.get(element);
    if (previous && previous !== source && sourceElements.get(previous) === element) sourceElements.delete(previous);
    if (source) {
      elementSources.set(element, source);
      sourceElements.set(source, element);
    } else elementSources.delete(element);
  }

  function currentMediaState(state) {
    if (state.document !== page.document || page.media.get(state.element) !== state) return false;
    return selectedMediaInput(state.element) === state.input;
  }

  // Detached sources can still finish queued appends or change their duration.
  // Only the selected source in this document may notify its current state.
  function attachedMediaState(source) {
    const element = sourceElements.get(source);
    const state = element && page.media.get(element);
    return state && element.ownerDocument === page.document && elementSources.get(element) === source
      && state.mediaSource === source && currentMediaState(state) ? state : null;
  }

  /** A resource record for a media element created after the document was parsed. */
  function ensureMediaResource(element) {
    if (!element || (element.tagName !== "VIDEO" && element.tagName !== "AUDIO")) return null;
    let resource = page.resources.get(element);
    if (resource) return resource;
    const audioOnly = element.tagName === "AUDIO";
    resource = {
      width: audioOnly ? 300 : Number(element.getAttribute("width")) || 300,
      height: audioOnly ? 32 : Number(element.getAttribute("height")) || 150,
      bitmapWidth: 0, bitmapHeight: 0, image: null, playing: false, time: 0, duration: NaN,
    };
    page.resources.set(element, resource);
    page.dirty = true;
    return resource;
  }

  /** src or srcObject points at a MediaSource: attach it and queue sourceopen. */
  function attachMediaSrc(element, value) {
    if (!element || element.ownerDocument !== page.document
      || (element.tagName !== "VIDEO" && element.tagName !== "AUDIO")) return;
    if (typeof value !== "string") {
      if (value == null) elementSourceObjects.delete(element);
      else elementSourceObjects.set(element, value);
    }
    // Updating an inactive src attribute must not replace srcObject playback.
    const state = mediaStateFor(element, typeof value !== "string" || !elementSourceObjects.has(element));
    if (!state) return;
    const source = state.mediaSource;
    if (!source) return;
    if (Number.isFinite(source.duration)) {
      state.durationOverride = true;
      state.duration = source.duration;
      if (state.resource) state.resource.duration = source.duration;
    }
    bindSourcePipes(state);
  }

  function mediaAppended(source) {
    const state = attachedMediaState(source);
    if (!state) return;
    bindSourcePipes(state);
    // A later initialization segment can replace already-buffered video.
    // Shorten the active presentation at its epoch boundary as soon as that
    // boundary is known, without discarding the frames before it.
    if (state.video?.pipe?.snapshotAt) {
      const current = state.video.pipe.snapshotAt(state.video.startTime);
      const endTime = current.id === state.video.snapshotId ? current.endTime : current.startTime;
      if (endTime !== state.video.endTime) {
        state.video.endTime = endTime;
        if (state.video.presentation) onVideo?.({ type: "video-bind", id: state.video.presentation.id,
          endTime });
      }
    }
    if (state.sound?.pipe?.snapshotAt) {
      const current = state.sound.pipe.snapshotAt(state.sound.startTime);
      state.sound.endTime = current.id === state.sound.snapshotId ? current.endTime : current.startTime;
    }
    if (state.audioPipe && state.audioPipe !== state.videoPipe) state.hasAudio = true;
    void refreshProbe(state);
    if (state.playing && state.hasAudio && !state.sound) ensureAudio(state);
  }

  function mediaDuration(source, seconds) {
    const state = attachedMediaState(source);
    if (!state || !Number.isFinite(seconds)) return;
    state.durationOverride = true;
    state.duration = seconds;
    if (state.resource) state.resource.duration = seconds;
    mediaEvent(state, "durationchange");
  }

  /** The element's playback state, created (not loaded) on first use. */
  function mediaStateFor(element, reselect = false) {
    if (!element || element.ownerDocument !== page.document) return null;
    const resource = ensureMediaResource(element);
    const { input, source, url } = selectedMediaSource(element, reselect);
    linkMediaSource(element, source);
    let state = page.media.get(element);
    if (state && (state.mediaSource !== source || (!source && (state.input !== input || reselect)))) {
      closeMedia(state);
      page.media.delete(element);
      state = null;
      resource.duration = NaN;
      resource.time = 0;
    }
    if (source && source.readyState === "closed") {
      try {
        source.attach(url);
      } catch {}
    }
    if (!videoDecoder || !resource || (!url && !source)) return null;
    if (!state) {
      state = { element, input, url, resource, bytes: null, pipe: null, videoPipe: null, audioPipe: null,
        loading: null, showsPicture: element.tagName === "VIDEO", mediaSource: source,
        video: null, sound: null, playing: false, ended: false,
        duration: Number.isFinite(source?.duration) ? source.duration : NaN, base: 0, clockStart: null,
        timer: null, lastTimeUpdate: -1, generation: loadGeneration, document: page.document,
        probed: false, hasVideo: false, hasAudio: false, buffering: false, refilling: null,
        seekSerial: 0, error: null, bufferedEnd: 0, contentType: "", videoMime: "", audioMime: "" };
      page.media.set(element, state);
      if (Number.isFinite(source?.duration)) {
        state.durationOverride = true;
        resource.duration = source.duration;
      }
    } else {
      state.input = input;
      state.url = url;
    }
    return state;
  }

  function reselectMedia(element) {
    return mediaStateFor(element, true);
  }

  /** Current position in seconds. */
  function mediaTime(state) {
    const sound = state.sound;
    if (state.playing && sound?.id != null && !sound.done) {
      const time = sound.playedTime ?? sound.streamStart / sound.decoder.sampleRate;
      return Number.isFinite(state.duration) ? Math.min(state.duration, time) : time;
    }
    // A known audio track which hasn't arrived must not leave its picture
    // running independently during a network outage.
    if (state.playing && state.hasAudio && audio && !sound) return state.base;
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
    // Independent presentation already replaces video pixels. Dirty page UI
    // must take the ordinary scheduled refresh, which rebuilds layout before
    // painting and coalesces changes; a media tick must not raster stale items.
    if (onFrame && !embedded
      && [...page.media.values()].some(state => state.video?.presentation && state.playing)) {
      // Another media element can still own a native progress/control bar.
      // Its mutable resource time is not a DOM mutation, so invalidate paint.
      if (page.displayList?.items.some(item => item.op === "drawAudio"
        || (item.op === "drawVideo" && item.controls))) {
        rasterized.list = null;
        page.needsPaint = true;
      }
      if (page.dirty || page.needsPaint) scheduleFrame();
      return;
    }
    rasterized.list = null;
    render();
  }

  function stopVideoPresentation(state) {
    const presentation = state.video?.presentation;
    if (!presentation) return;
    readPresentedFrame(state);
    presentation.continuation?.decoder?.close();
    if (presentation.continuation) presentation.continuation.decoder = null;
    presentation.continuation = null;
    onVideo?.({ type: "video-stop", id: presentation.id });
    state.video.presentation = null;
    state.video.needsLocalPosition = true;
  }

  function finishVideoPresentation(state, end) {
    state.video.frameTime = end;
    if (needsMore(state.video)) void refillMedia(state, state.video);
    else {
      readPresentedFrame(state);
      stopVideoPresentation(state);
      state.video.done = true;
    }
  }

  function failVideoContinuation(state, presentation) {
    if (state.video?.presentation !== presentation) return;
    presentation.continuation?.decoder?.close();
    if (presentation.continuation) presentation.continuation.decoder = null;
    presentation.continuation = null;
    const end = presentation.pendingEnd;
    presentation.pendingEnd = null;
    if (Number.isFinite(end)) finishVideoPresentation(state, end);
  }

  // A decoded snapshot can end before its queued pixels are displayed. If
  // bytes for the same source/configuration already exist, extend that worker
  // without dispatching waiting, stopping audio or replacing the raster mask.
  // The ordinary refill path still handles actual starvation and new epochs.
  function continueVideoSnapshot(state, boundary) {
    const video = state.video, p = video?.presentation, pipe = video?.pipe;
    if (!p || p.continuation || !state.playing || state.buffering || !pipe || pipe.error
      || pipe !== (state.videoPipe ?? state.pipe) || boundary + 1e-6 >= video.endTime
      || !Number.isSafeInteger(pipe.generation) || pipe.generation <= video.openedGeneration
      || pipe.generation <= (p.attemptedGeneration ?? -1)) return false;
    const generation = pipe.generation;
    let selected, bytes;
    try {
      selected = pipe.snapshotAt?.(boundary);
      if (selected && (selected.id !== video.snapshotId || selected.startTime !== video.startTime
        || boundary + 1e-6 >= selected.endTime)) return false;
      bytes = selected?.bytes ?? pipe.bytes();
    } catch { return false; }
    if (!(bytes instanceof Uint8Array) || bytes.length <= video.bytes.length) return false;
    const serial = state.seekSerial;
    const continuation = p.continuation = { bytes, generation, decoder: null };
    p.attemptedGeneration = generation;
    const current = () => state.document === page.document && state.playing && !state.buffering
      && state.seekSerial === serial && state.video === video && video.presentation === p
      && p.continuation === continuation && pipe === (state.videoPipe ?? state.pipe)
      && boundary + 1e-6 < video.endTime;
    // Keep a correctly opened, lazy page decoder for controls/layout fallback.
    // Only one replacement is staged; cancellation closes it before reuse.
    void (async () => {
      let decoder;
      try {
        decoder = await videoDecoder.decode(bytes, decodeOptions(state.videoMime || state.contentType, state.url));
        if (!current()) { decoder.close(); decoder = null; failVideoContinuation(state, p); return; }
        if (decoder.width !== video.decoder.width || decoder.height !== video.decoder.height || decoder.fps !== video.decoder.fps)
          throw new Error("video snapshot configuration changed");
        continuation.decoder = decoder;
        decoder = null;
        onVideo({ type: "video-extend", id: p.id, revision: p.revision, snapshotId: video.snapshotId,
          generation, bytes, boundary });
      } catch {
        decoder?.close();
        failVideoContinuation(state, p);
      }
    })();
    return true;
  }

  function readPresentedFrame(state) {
    const p = state.video?.presentation;
    if (!p) return;
    const meta = new Int32Array(p.shared, 0, 4);
    const serial = Atomics.load(meta, 0);
    if (serial % 2 || !serial || serial === p.serial) return;
    const width = Atomics.load(meta, 1), height = Atomics.load(meta, 2);
    if (width < 1 || height < 1 || width * height > 480 * 480) return;
    const pixels = new Uint8Array(p.shared, 16, width * height * 4).slice();
    if (serial !== Atomics.load(meta, 0)) return;
    const image = CanvasKit.MakeImage({ width, height, alphaType: CanvasKit.AlphaType.Unpremul,
      colorType: CanvasKit.ColorType.RGBA_8888, colorSpace: CanvasKit.ColorSpace.SRGB }, pixels, width * 4);
    if (!image) return;
    state.resource.image?.delete();
    Object.assign(state.resource, { image, bitmapWidth: width, bitmapHeight: height });
    // Decoder formats may carry alpha. Retain only this coherent frame's
    // owned copy; stopping/replacing the presentation releases it.
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) { opaque = false; break; }
    p.frame = {pixels,width,height,opaque};
    p.serial = serial;
  }

  function blackVideoPlan(region) {
    if (!onVideo || embedded) return null;
    const items = [...visibleItems(page.displayList, region, viewport)].filter(item => item.op === "drawVideo");
    if (items.length !== 1) return null;
    const item = items[0], resource = page.displayList.images[item.image];
    const state = [...page.media.values()].find(state => state.resource === resource);
    const frame = state?.video?.presentation?.frame;
    if (!frame?.opaque || !state.playing || state.video.done || state.buffering || state.presentationFailed
      || state.document !== page.document || !state.element.isConnected || item.controls || item.fixed) return null;
    if (!videoLayerGeometry(item,region,page.deviceScaleFactor).replayable) return null;
    return {resource,frame};
  }

  function makeVideoLayer(canvas, surface, region, scale, width, height, pixels, blackResource = null) {
    if (!onVideo) return null;
    const items = [...visibleItems(page.displayList, region, viewport)].filter(item => item.op === "drawVideo");
    const item = items.length === 1 ? items[0] : null;
    const resource = item && page.displayList.images[item.image];
    const state = [...page.media.values()].find(state => state.resource === resource);
    const eligible = state?.playing && state.video && !state.video.done && !state.buffering
      && !state.presentationFailed && !item.controls && !item.fixed
      && (!item.transform || (item.transform.a > 0 && item.transform.d > 0));
    for (const other of page.media.values()) if (!eligible || other !== state) stopVideoPresentation(other);
    if (!eligible) return null;
    const video = state.video;
    if (!video.presentation) {
      const id = nextVideoPresentation++;
      const shared = new SharedArrayBuffer(16 + 480 * 480 * 4);
      video.presentation = { id, shared, serial: 0, revision: 0 };
      onVideo({ type: "video-open", id, shared, bytes: video.bytes,
        snapshotId: video.snapshotId, generation: video.openedGeneration,
        options: decodeOptions(state.videoMime || state.contentType, state.url), time: mediaTime(state),
        startTime: video.startTime ?? 0, endTime: video.endTime ?? Infinity,
        hasAudio: state.hasAudio, audioId: state.sound?.id ?? null,
        audioStart: state.sound ? state.sound.streamStart / state.sound.decoder.sampleRate : 0 });
    }
    const {rect} = videoLayerGeometry(item,region,scale);
    // Reuse the ordinary raster outside the video. Only this region can
    // differ between the black/white passes, including subtitles and overlays.
    const bounds = videoMaskBounds(item, region, scale, width, height);
    let cullPadding = 2;
    for (const entry of page.displayList.items) if (entry.transform) {
      // Display-list bounds are in CSS space; transformed device rounding may
      // reach beyond them. Unknown transforms keep conservative full culling.
      const {a, d} = entry.transform;
      cullPadding = Math.max(cullPadding, Math.abs(a) + 1, Math.abs(d) + 1);
    }
    const {base, mask} = rasterVideoMask({kit:CanvasKit, canvas, surface, width, height, pixels,
      bounds, region, scale, cullPadding, blackAlreadyRasterized:blackResource === resource, background:canvasColor(CanvasKit, page.backgroundColor),
      paint:(white, dirtyView) => paintDisplayList(canvas, page.displayList, region, scale, {resource, white}, dirtyView),
      hints:() => drawHints(canvas, region),
    });
    return { id: video.presentation.id, base, mask, rect };
  }

  function isPipe(value) {
    return Boolean(value && typeof value.waitFor === "function" && typeof value.bytes === "function");
  }

  function bindSourcePipes(state) {
    const pipes = state.mediaSource?.streamPipes?.();
    if (!pipes) return;
    if (pipes.video) state.videoPipe = pipes.video;
    if (pipes.audio) state.audioPipe = pipes.audio;
    state.pipe = state.videoPipe ?? state.audioPipe ?? state.pipe;
    state.videoMime = pipes.videoMime || state.videoMime;
    state.audioMime = pipes.audioMime || state.audioMime;
    state.audioHasMedia = pipes.audioReady;
  }

  /** Fetches (or attaches MSE pipes), probes a prefix, and opens decoders. */
  function loadMedia(state) {
    state.loading ??= (async () => {
      if (state.mediaSource) {
        await state.mediaSource.waitForPipes();
        if (!currentMediaState(state)) return;
        bindSourcePipes(state);
      }
      if (!state.pipe && !state.bytes && !state.mediaSource) {
        const response = await fetchResource(state.url, state.showsPicture ? "video" : "audio");
        if (!currentMediaState(state)) return;
        if (!response.ok) throw new Error(`media ${state.url} failed with HTTP ${response.status}`);
        state.contentType = response.contentType ?? "";
        if (isPipe(response.body)) {
          state.pipe = response.body;
          state.videoPipe = state.pipe;
          state.audioPipe = state.pipe;
        } else {
          state.bytes = response.body;
        }
      }
      await ensureProbed(state);
      if (!currentMediaState(state)) return;
      if (!state.mediaSource) watchProgressiveMetadata(state);
      if (state.hasVideo && !state.video) await openVideoDecoder(state);
      // A separate audio buffer often arrives as an init segment, or empty.
      // That is not a broken video: picture plays, and sound attaches later.
      if (state.hasAudio && audio && !state.sound) {
        try {
          let opened = await openAudioDecoder(state);
          // With separate MSE buffers the audio init segment often arrives
          // before its first media segment. Starting the video clock here
          // makes ensureAudio seek past the opening words once sound becomes
          // decodable. Briefly wait for that first segment so both start at 0.
          const audioPipe = state.audioPipe ?? state.pipe;
          const separateAudio = state.audioPipe && state.audioPipe !== state.videoPipe;
          if (state.video && audioPipe && !audioPipe.done && !audioPipe.error
            && (!opened || (separateAudio && !state.audioHasMedia))) {
            const deadline = hostPerformance.now() + 750;
            do {
              const mark = audioPipe.size + 1;
              const remaining = Math.max(0, deadline - hostPerformance.now());
              await Promise.race([
                audioPipe.waitFor(mark),
                new Promise((resolve) => hostSetTimeout(resolve, remaining)),
              ]);
              bindSourcePipes(state);
            } while (separateAudio && !state.audioHasMedia && !audioPipe.done && !audioPipe.error
              && hostPerformance.now() < deadline);
            if (!audioPipe.error) opened = await openAudioDecoder(state);
          }
        } catch (error) {
          if (!state.video) throw error;
          reportError(error);
        }
      }
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // A probe belongs to one immutable snapshot, not merely one media element.
  // Read MSE's current pipes directly: removeSourceBuffer/changeType can happen
  // while the demuxer is awaiting its result, before another append notifies us.
  function mediaProbeInput(state, time = 0) {
    const pipes = state.mediaSource?.streamPipes?.();
    const pipe = pipes ? pipes.video : state.videoPipe ?? state.pipe;
    const selected = pipe?.snapshotAt?.(time);
    return { pipe, generation: pipe?.generation, id: selected?.id,
      start: selected?.startTime, end: selected?.endTime,
      mime: pipes?.videoMime ?? state.videoMime ?? state.contentType,
      bytes: selected?.bytes ?? (pipe ? pipe.bytes() : state.bytes) };
  }

  function sameMediaProbeInput(a, b) {
    return a && a.pipe === b.pipe && a.generation === b.generation
      && a.id === b.id && a.start === b.start && a.end === b.end && a.mime === b.mime
      // Versioned pipe snapshots are immutable. An incomplete MP4 header can
      // be reassembled into a fresh array on each read without new input.
      && (a.bytes === b.bytes || (a.pipe && Number.isSafeInteger(a.generation)
        && a.bytes?.byteLength === b.bytes?.byteLength));
  }

  async function probeMediaInput(state, input) {
    if (sameMediaProbeInput(state.lastProbe?.input, input)) return state.lastProbe.result;
    const result = await videoDecoder.probe(input.bytes);
    // A failed probe remains retryable, including retries of identical bytes.
    state.lastProbe = { input, result };
    return result;
  }

  async function waitForProbeBytes(state, input, size) {
    let waiting = state.probeByteWait;
    if (!waiting || waiting.pipe !== input.pipe || waiting.size !== size) {
      waiting = { pipe: input.pipe, size, promise: null };
      waiting.promise = input.pipe.waitFor(size).finally(() => {
        if (state.probeByteWait === waiting) state.probeByteWait = null;
      });
      state.probeByteWait = waiting;
    }
    let wake;
    const changed = new Promise(resolve => { wake = resolve; state.wakeProbe = resolve; });
    state.probeWaitInput = input;
    try { await Promise.race([waiting.promise, changed]); }
    finally {
      if (state.wakeProbe === wake) { state.wakeProbe = null; state.probeWaitInput = null; }
    }
  }

  /** Probe until the growing body exposes a picture or sample rate, or ends. */
  function ensureProbed(state) {
    if (state.probed) return;
    // loadMedia and the first append share this transaction. A second waiter
    // must not start another probe or wait forever for an unnecessary byte.
    return state.initialProbe ??= probeInitialMedia(state).finally(() => { state.initialProbe = null; });
  }

  async function probeInitialMedia(state) {
    let rejected = null;
    while (currentMediaState(state) && !state.error) {
      const input = mediaProbeInput(state), {pipe, bytes} = input;
      if (pipe?.error) throw pipe.error;
      if (pipe && !pipe.done && sameMediaProbeInput(rejected, input)) {
        await waitForProbeBytes(state, input, pipe.size + 1);
        continue;
      }
      if (!bytes?.byteLength) {
        if (!pipe || pipe.done) throw new Error(`media ${state.url}: empty response`);
        await waitForProbeBytes(state, input, pipe.size + 1);
        continue;
      }
      try {
        const probe = await probeMediaInput(state, input);
        if (!currentMediaState(state)) return;
        if (!sameMediaProbeInput(input, mediaProbeInput(state))) continue;
        const videoReady = probe.video?.width > 0;
        const audioReady = probe.audio?.sampleRate > 0;
        if (!videoReady && !audioReady) {
          if (!pipe || pipe.done) throw new Error(`media ${state.url}: no supported tracks`);
          rejected = input;
          continue;
        }
        if (!state.durationOverride) state.duration = probe.duration ?? NaN;
        state.hasVideo = Boolean(state.showsPicture && videoReady);
        state.hasAudio = Boolean(audioReady || (state.audioPipe && state.audioPipe !== pipe));
        state.probed = true;
        const end = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0.001;
        state.bufferedEnd = end;
        state.mediaSource?.noteBuffered(end);
        state.resource.duration = state.duration;
        mediaEvent(state, "loadedmetadata");
        return;
      } catch (error) {
        if (!currentMediaState(state)) return;
        if (!sameMediaProbeInput(input, mediaProbeInput(state))) continue;
        if (!pipe || pipe.done) throw error;
        rejected = input;
      }
    }
  }

  /** A later MSE append can extend the duration and the buffered range. */
  function refreshProbe(state) {
    // Audio-only appends do not wake a waiter on unchanged video bytes.
    if (state.wakeProbe && !sameMediaProbeInput(state.probeWaitInput, mediaProbeInput(state))) state.wakeProbe();
    state.probePending = true;
    if (state.probing) return state.probing;
    state.probing = (async () => {
      do {
        state.probePending = false;
        if (!currentMediaState(state)) return;
        if (!state.probed) {
          try { await ensureProbed(state); } catch {}
          continue;
        }
        const time = mediaTime(state), input = mediaProbeInput(state, time);
        if (!input.pipe?.size) continue;
        try {
          const probe = await probeMediaInput(state, input);
          if (!currentMediaState(state)) return;
          // Compare the same selection point. Continuous WebM snapshots trim
          // their prefix as playback advances, even without any new input.
          // A seek into another initialization epoch must still reject the
          // old result; reading only its id leaves lazy snapshot bytes alone.
          if (!sameMediaProbeInput(input, mediaProbeInput(state, time))
            || (input.id !== undefined && input.pipe.snapshotAt(mediaTime(state)).id !== input.id)) {
            state.probePending = true;
            continue;
          }
          if (!state.durationOverride && probe.duration != null && probe.duration !== state.duration) {
            state.duration = probe.duration;
            state.resource.duration = probe.duration;
            mediaEvent(state, "durationchange");
          }
          const end = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : Math.max(state.bufferedEnd, 0.001);
          state.bufferedEnd = end;
          state.mediaSource?.noteBuffered(end);
          if (probe.video?.width > 0 && state.showsPicture) state.hasVideo = true;
          if (probe.audio?.sampleRate > 0) state.hasAudio = true;
        } catch {}
      } while (state.probePending);
    })().finally(() => {
      state.probing = null;
      // A notification queued as this promise settles still needs one pass.
      if (state.probePending && currentMediaState(state)) void refreshProbe(state);
    });
    return state.probing;
  }

  /** Refresh duration as a progressive response grows, especially MP3. */
  function watchProgressiveMetadata(state) {
    const pipe = state.pipe;
    if (!pipe || pipe.done || state.metadataWatch) return;
    state.metadataWatch = (async () => {
      let mark = Math.max(pipe.size + 1, pipe.size * 2);
      while (state.document === page.document && !pipe.error) {
        await pipe.waitFor(mark);
        if (state.document !== page.document || pipe.error) return;
        await refreshProbe(state);
        if (pipe.done) return;
        mark = Math.max(pipe.size + 64 * 1024, pipe.size * 2);
      }
    })().catch((error) => reportError(error)).finally(() => {
      state.metadataWatch = null;
    });
  }

  // Content-probed when the URL has a container extension. Blob MSE URLs do
  // not, so the SourceBuffer MIME selects the demuxer.
  function decodeOptions(mime, url) {
    let path = "";
    try {
      path = url ? new URL(url).pathname : "";
    } catch {}
    const hint = formatHint(path);
    if (hint) return { format: hint };
    if (/\.(mp4|m4v|m4a|webm|mkv|ogg|ogv|mp3|wav|aac|flac)$/i.test(path)) return {};
    const format = containerFormat(mime);
    return format ? { format } : {};
  }

  function snapshot(pipe, bytes, time = 0) {
    return pipe?.snapshotAt ? pipe.snapshotAt(time).bytes : pipe ? pipe.bytes() : bytes;
  }

  async function openVideoDecoder(state, time = mediaTime(state)) {
    stopVideoPresentation(state);
    const pipe = state.videoPipe ?? state.pipe;
    const generation = pipe?.generation ?? 0;
    const selected = pipe?.snapshotAt?.(time);
    const bytes = selected?.bytes ?? snapshot(pipe, state.bytes);
    if (!bytes?.byteLength) throw new Error(`media ${state.url}: no video bytes`);
    state.video?.decoder.close();
    const decoder = await videoDecoder.decode(bytes, decodeOptions(state.videoMime || state.contentType, state.url));
    state.video = { decoder, bytes, frameTime: selected?.startTime ?? 0, done: false, pipe, openedGeneration: generation,
      snapshotId: selected?.id, startTime: selected?.startTime ?? 0, endTime: selected?.endTime ?? Infinity };
    trace?.(`video decoded ${state.url}: ${decoder.width}x${decoder.height}`);
    if (state.resource.width !== decoder.width || state.resource.height !== decoder.height) {
      state.resource.width = decoder.width;
      state.resource.height = decoder.height;
      page.dirty = true;
      refresh();
    }
  }

  /**
   * Opens the audio decoder on the current snapshot.
   * Returns false when the pipe can still grow into something decodable
   * (no bytes yet, or audio_open hit EOF / invalid data on a short prefix).
   * The previous decoder stays until a new one succeeds.
   */
  async function openAudioDecoder(state, { keepStream = false, time = mediaTime(state) } = {}) {
    const serial = state.seekSerial;
    const operation = (state.audioOpenSerial ?? 0) + 1;
    state.audioOpenSerial = operation;
    const pipe = state.audioPipe ?? state.pipe;
    const generation = pipe?.generation ?? 0;
    const selected = pipe?.snapshotAt?.(time);
    const bytes = selected?.bytes ?? snapshot(pipe, state.bytes);
    const pending = pipe && !pipe.done && !pipe.error;
    if (!bytes?.byteLength) {
      if (pending) return false;
      throw new Error(`media ${state.url}: no audio bytes`);
    }
    let decoder;
    try {
      decoder = await videoDecoder.decodeAudio(bytes, decodeOptions(state.audioMime || state.contentType, state.url));
    } catch (error) {
      if (pending || (pipe && pipe.generation !== generation)) return false;
      throw error;
    }
    let firstSamples = null;
    try {
      firstSamples = decoder.nextSamples();
    } catch (error) {
      decoder.close();
      if (pending || (pipe && pipe.generation !== generation)) return false;
      throw error;
    }
    if (!firstSamples && pending) {
      decoder.close();
      return false;
    }
    if (state.document !== page.document || state.seekSerial !== serial || state.audioOpenSerial !== operation) {
      decoder.close();
      return false;
    }
    const previous = state.sound;
    const previousId = previous?.id ?? null;
    if (keepStream && previousId != null
      && (previous.decoder.sampleRate !== decoder.sampleRate || previous.decoder.channels !== decoder.channels)) {
      decoder.close();
      throw new Error("audio format changed while output stream is active");
    }
    previous?.decoder.close();
    state.sound = { decoder, id: null, position: Math.round((selected?.startTime ?? 0) * decoder.sampleRate),
      pending: firstSamples, history: [], finishing: false, done: false,
      pipe, openedGeneration: generation, snapshotId: selected?.id,
      startTime: selected?.startTime ?? 0, endTime: selected?.endTime ?? Infinity };
    if (keepStream && previousId != null) {
      // The output stream carries on with the new decoder's samples.
      Object.assign(state.sound, { id: previousId, streamStart: previous.streamStart,
        playedTime: previous.playedTime, owed: previous.owed ?? 0 });
    } else if (previousId != null) audio?.close(previousId);
    trace?.(`audio decoded ${state.url}: ${decoder.sampleRate} Hz, ${decoder.channels} channels`);
    return true;
  }

  /** Attaches sound once a separate audio buffer becomes decodable. */
  function ensureAudio(state) {
    // loadMedia/refillMedia own decoder replacement. An append arriving while
    // either awaits bytes must not start a second opener and reset live audio
    // back to the first packet.
    if (state.loading || state.refilling || state.sound || state.audioWatch || !state.hasAudio || !audio) return;
    const pipe = state.audioPipe ?? state.pipe;
    if (!pipe) return;
    state.audioWatch = (async () => {
      try {
        while (state.playing && !state.sound && state.document === page.document) {
          let opened = false;
          try {
            opened = await openAudioDecoder(state);
          } catch (error) {
            if (state.video) reportError(error);
            else if (state.document === page.document) failMedia(state, error, 4);
            return;
          }
          if (opened && state.sound && state.playing && state.document === page.document) {
            await positionAudio(state, mediaTime(state));
            if (state.sound && !state.sound.id) openAudioStream(state);
            return;
          }
          if (state.sound || pipe.done || pipe.error) return;
          const size = pipe.size;
          await pipe.waitFor(size + 1);
        }
      } finally {
        state.audioWatch = null;
      }
    })();
  }

  /**
   * The decoder was opened on a snapshot that is not the finished body.
   * null and a truncated-file error both mean "wait", not "ended".
   */
  function needsMore(track) {
    const pipe = track?.pipe;
    if (!pipe || pipe.error) return false;
    const atBoundary = Number.isFinite(track.endTime) && (track.frameTime !== undefined
      ? track.frameTime + 1e-6 >= track.endTime
      : track.position >= Math.round(track.endTime * track.decoder.sampleRate));
    return pipe.generation !== track.openedGeneration || !pipe.done || atBoundary;
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
    state.error = null;
    setMediaPlaying(state, true);
    playbackEvent(state, "play", mediaEvent);
    try {
      await loadMedia(state);
      if (!currentMediaState(state)) return;
      if (state.ended) {
        state.ended = false;
        await positionMedia(state, 0);
      } else if (state.needsPosition) {
        // After a pause the audio decoder is ahead of where playing resumes.
        const moved = await skipPlayedAudio(state);
        await positionMedia(state, state.base, { videoToo: moved });
      }
      state.needsPosition = false;
    } catch (error) {
      if (currentMediaState(state)) failMedia(state, error, state.pipe?.error ? 2 : 4);
      return;
    }
    if (!state.playing || state.document !== page.document) return;
    if (!state.video && !state.sound) {
      // Nothing this engine can play (audio with no audio output).
      failMedia(state, new Error(`media ${state.url}: nothing to play`), 4);
      return;
    }
    startMedia(state);
  }

  function pauseMedia(element) {
    const state = page.media.get(element);
    if (!state?.playing) return;
    state.base = mediaTime(state);
    trace?.(`media pause at ${state.base.toFixed(3)}s`);
    stopClock(state);
    state.needsPosition = true;
    setMediaPlaying(state, false);
    playbackEvent(state, "pause", mediaEvent);
  }

  async function seekMedia(element, seconds) {
    const state = mediaStateFor(element);
    if (!state) return;
    trace?.(`media seek to ${Number(seconds).toFixed(3)}s from ${mediaTime(state).toFixed(3)}s`);
    const serial = ++state.seekSerial;
    const wasPlaying = state.playing;
    if (wasPlaying) stopClock(state);
    // A seek goes where it is told, whatever the output still plays.
    state.outputEnd = null;
    try {
      if (state.refilling) await state.refilling.catch(() => {});
      if (state.seekSerial !== serial) return;
      await loadMedia(state);
      if (state.seekSerial !== serial || !currentMediaState(state)) return;
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
    if (state.video && videoToo) await placeVideo(state, seconds);
    if (state.sound) await positionAudio(state, seconds);
  }

  /** Seek, reopening on a longer snapshot when the target is not in this prefix yet. */
  async function placeVideo(state, seconds) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const pipe = state.videoPipe ?? state.pipe;
      const selected = pipe?.snapshotAt?.(seconds);
      // A seek beyond an old snapshot can succeed at its last keyframe.
      // Reopen on newer bytes first; an exception does not detect that case.
      const stale = pipe && (pipe !== state.video?.pipe || pipe.generation !== state.video?.openedGeneration);
      if (!state.video || state.video.done || seconds === 0 || attempt > 0
        || stale || (selected && selected.id !== state.video.snapshotId)) await openVideoDecoder(state, seconds);
      try {
        state.video.frameTime = seekToKeyframe(state.video.decoder, seconds, state.video.startTime, state.video.bytes);
        state.video.hideUntil = seconds;
        state.video.done = false;
        return;
      } catch (error) {
        if (!needsMore(state.video)) throw error;
        const pipe = state.video.pipe;
        const size = pipe.size;
        await pipe.waitFor(size + 1);
        if (pipe.error) throw pipe.error;
        if (pipe.size === size) throw error;
      }
    }
  }

  /** Puts the audio decoder at `seconds`: from the kept history, by decoding ahead, or from the start. */
  async function positionAudio(state, seconds) {
    const transaction = {};
    state.audioPositioning = transaction;
    const serial = state.seekSerial;
    try {
      if (state.sound) trace?.(`audio positioned at ${seconds.toFixed(3)}s (was at ${(state.sound.position / state.sound.decoder.sampleRate).toFixed(3)}s)`);
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
      sound.history = [];
      const reached = await advanceAudio(() => state.sound, seconds, {
        needsMore,
        active: () => state.audioPositioning === transaction && state.seekSerial === serial && state.document === page.document,
        reopen: () => openAudioDecoder(state, { keepStream: true, time: seconds }),
      });
      if (!reached && state.audioPositioning === transaction && state.seekSerial === serial) {
        throw new Error(`audio could not reach ${seconds.toFixed(3)}s; refusing to replay an earlier prefix`);
      }
    } finally {
      if (state.audioPositioning === transaction) state.audioPositioning = null;
    }
  }

  /** Starts the clock, the audio stream and the frame/time ticks. */
  function startMedia(state) {
    hostClearTimeout(state.timer);
    state.timer = null;
    // An output stream held through a stall (see refillMedia) is already
    // open: the clock goes on from where its audio is, and what it asked for
    // meanwhile is sent now.
    if (state.sound && !state.sound.done && state.sound.id != null) {
      const sound = state.sound;
      state.base = mediaTime(state);
      state.clockStart = hostPerformance.now();
      if (state.resyncAudio) audio.resync?.(sound.id);
      state.resyncAudio = false;
      const owed = sound.owed ?? 0;
      sound.owed = 0;
      if (owed > 0) feedAudio(state, owed);
      mediaTick(state);
      return;
    }
    // Opening a PulseAudio stream is asynchronous. Advancing the video clock
    // before the output is ready used to make a later decoder reopen seek
    // audio past PCM which had not actually reached the output yet. Let the
    // output stream establish the common A/V epoch instead.
    if (state.sound && !state.sound.done) {
      state.clockStart = null;
      state.awaitingAudio = true;
      openAudioStream(state);
      // A misbehaving output server must not freeze video forever. Normally
      // ready/request arrives almost immediately; this is only a safety net.
      state.audioClockTimer = hostSetTimeout(() => startAudioClock(state, state.sound), 500);
      return;
    }
    state.clockStart = hostPerformance.now();
    if (state.hasAudio) ensureAudio(state);
    mediaTick(state);
  }

  /** Releases a clock which was waiting for audio output to become writable. */
  function startAudioClock(state, sound) {
    if (!state.awaitingAudio || state.sound !== sound || !state.playing) return;
    state.awaitingAudio = false;
    hostClearTimeout(state.audioClockTimer);
    state.audioClockTimer = null;
    state.clockStart = hostPerformance.now();
    mediaTick(state);
  }

  function stopClock(state, { keepAudio = false } = {}) {
    stopVideoPresentation(state);
    hostClearTimeout(state.timer);
    state.timer = null;
    state.clockStart = null;
    state.awaitingAudio = false;
    hostClearTimeout(state.audioClockTimer);
    state.audioClockTimer = null;
    state.outputEnd = null;
    if (state.sound?.id != null && !keepAudio) {
      const sound = state.sound;
      trace?.(`audio stream closed at ${(sound.position / sound.decoder.sampleRate).toFixed(3)}s written, clock ${mediaTime(state).toFixed(3)}s`);
      const { sampleRate, channels } = sound.decoder;
      const start = sound.streamStart ?? sound.position;
      // The output may go on playing the PCM it already holds (some servers
      // drain a closed stream): playing resumes after it, not twice.
      state.outputEnd = Promise.resolve(audio.close(sound.id))
        .then((sentBytes) => (start + (Number(sentBytes) || 0) / (2 * channels)) / sampleRate, () => null);
      sound.id = null;
      sound.finishing = false;
    }
  }

  /**
   * Moves the media clock past the audio the closed output stream still
   * plays (see stopClock). True when it moved, so video must follow.
   */
  async function skipPlayedAudio(state) {
    const end = await (state.outputEnd ?? null);
    state.outputEnd = null;
    if (!Number.isFinite(end) || end <= state.base) return false;
    state.base = Number.isFinite(state.duration) ? Math.min(state.duration, end) : end;
    return true;
  }

  /** Draws the frames the clock has reached, updates time, ends when everything has played. */
  function mediaTick(state) {
    if (!state.playing || state.generation !== loadGeneration || state.document !== page.document) return;
    const now = mediaTime(state);
    const video = state.video;
    if (video?.needsLocalPosition && !video.presentation && !video.done) {
      try {
        video.frameTime = seekToKeyframe(video.decoder, now, video.startTime, video.bytes);
        video.hideUntil = now;
        video.needsLocalPosition = false;
      } catch (error) { failMedia(state, error, 3); return; }
    }
    if (video?.presentation) {
      // Decode and present on the compositor thread. This tick only updates
      // DOM media state; it must not decode the same movie a second time.
      video.frameTime = now + 1 / (video.decoder.fps || 30);
    } else if (video && !video.done && video.frameTime <= now) {
      // Late frames are decoded but only the newest is shown.
      const decodeDeadline = hostPerformance.now() + 100;
      while (video.frameTime <= mediaTime(state) && !video.done) {
        const current = mediaTime(state);
        const nextIsLate = video.frameTime + 1 / (video.decoder.fps || 30) <= current;
        // If this tick has spent its decode budget, decode one final frame
        // for display before yielding. Otherwise a video that can never quite
        // catch the wall clock discards every frame forever while its controls
        // continue to advance.
        const yielding = hostPerformance.now() >= decodeDeadline;
        // Frames before where the picture already was (or a seek's target)
        // are decoded unshown: the decoder restarted at an earlier keyframe.
        const reached = video.frameTime + 1e-6 >= (video.hideUntil ?? 0);
        let step;
        try {
          step = drawVideoFrame(state, reached && (!nextIsLate || yielding));
        } catch (error) {
          failMedia(state, error, 3);
          return;
        }
        if (step === "stall") {
          void refillMedia(state, video);
          return;
        }
        if (!step) video.done = true;
        // Keep tasks responsive even when software decoding is slower than
        // real time. The zero-delay continuation resumes catching up against
        // a freshly read clock instead of accumulating this task's duration.
        if (yielding && video.frameTime <= mediaTime(state)) break;
      }
    }
    state.resource.time = now;
    if (!state.buffering && !state.awaitingAudio) {
      playbackEvent(state, "playing", mediaEvent);
      if (!state.playing) return;
    }
    repaintMedia();
    if (Math.floor(now * 4) !== state.lastTimeUpdate) {
      state.lastTimeUpdate = Math.floor(now * 4);
      mediaEvent(state, "timeupdate");
    }
    const videoFinished = !video || video.done;
    const soundFinished = !state.sound || state.sound.done;
    // The clock at the duration ends it too: after a seek, frames restart at a
    // keyframe before the target, and wasmpeg does not tell their timestamps.
    // A prefix can already report the full duration, so the clock must not
    // run the element out while bytes are still arriving.
    const pastEnd = !state.buffering && Number.isFinite(state.duration) && now >= state.duration;
    const pipeOpen = state.pipe && !state.pipe.done && !state.pipe.error;
    if (pastEnd && pipeOpen) {
      const stale = state.video && needsMore(state.video) ? state.video
        : state.sound && needsMore(state.sound) ? state.sound : null;
      void refillMedia(state, stale);
      return;
    }
    if (videoFinished && soundFinished && pipeOpen) {
      const stalled = video?.done && needsMore(video) ? video
        : state.sound?.done && needsMore(state.sound) ? state.sound : null;
      void refillMedia(state, stalled);
      return;
    }
    if ((videoFinished && soundFinished) || (pastEnd && soundFinished)) return endMedia(state);
    const delay = video && !video.done ? Math.max(0, (video.frameTime - mediaTime(state)) * 1000) : 250;
    state.timer = hostSetTimeout(() => mediaTick(state), delay);
  }

  /**
   * Decodes the next frame; shows it when `show`.
   * True when a frame was produced, false at a real end, "stall" when the
   * pipe still owes bytes (a short mp4 throws AVERROR_INVALIDDATA there).
   */
  function drawVideoFrame(state, show) {
    const video = state.video;
    const decoder = video.decoder;
    if (video.frameTime + 1e-6 >= video.endTime) return "stall";
    const width = Math.min(480, decoder.width);
    const height = Math.max(1, Math.round(width * decoder.height / Math.max(1, decoder.width)));
    let pixels;
    try {
      pixels = decoder.nextFrame(width, height);
    } catch (error) {
      if (needsMore(video)) return "stall";
      throw error;
    }
    if (!pixels) return needsMore(video) ? "stall" : false;
    const shownTime = state.video.frameTime;
    state.video.frameTime += 1 / (decoder.fps || 30);
    if (!show) return true;
    state.video.shownTime = shownTime;
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
    const name = new URL(state.url ?? state.document.URL).pathname.split("/").pop() || "audio";
    // Where this stream's PCM starts, to tell where its output ends when it closes (see stopClock).
    sound.streamStart = sound.position;
    trace?.(`audio stream opened at ${(sound.position / sound.decoder.sampleRate).toFixed(3)}s`);
    const id = audio.open({ rate: sound.decoder.sampleRate, channels: sound.decoder.channels, name }, (event) => {
      // The stream outlives a decoder reopened during a stall (see
      // refillMedia), so events go to whichever sound holds it now.
      const sound = state.sound;
      if (!sound || sound.id !== id) return;
      if (event.event === "timing") {
        if (!Number.isFinite(event.seconds) || event.seconds < 0) return;
        sound.playedTime = (sound.streamStart / sound.decoder.sampleRate) + event.seconds;
        state.base = sound.playedTime;
        sound.timingError = false;
        const now = hostPerformance.now();
        if (!state.lastSyncTrace || now - state.lastSyncTrace >= 1000) {
          state.lastSyncTrace = now;
          trace?.(`media sync: audio played ${sound.playedTime.toFixed(3)}s, video shown ${(state.video?.shownTime ?? 0).toFixed(3)}s,`
            + ` output queued ${Math.max(0, event.sentSeconds - event.seconds).toFixed(3)}s, sink ${Number(event.sinkSeconds ?? 0).toFixed(3)}s`
            + `, PCM reserve ${Number(event.bufferedSeconds ?? 0).toFixed(3)}s`);
        }
      } else if (event.event === "timing-error") {
        // Do not silently switch to a free-running clock on missing feedback.
        if (!sound.timingError) reportError(new Error(`audio timing unavailable; playback clock held: ${event.message}`));
        sound.timingError = true;
      } else if (event.event === "request") {
        // A request is the first point at which PulseAudio has created the
        // playback stream. Queue its PCM before releasing the clock: feeding
        // a decoder opened on a growing snapshot can itself start a refill,
        // in which case that replacement stream must establish the epoch.
        feedAudio(state, event.bytes);
        startAudioClock(state, sound);
      } else if (event.event === "ready") {
        // Some servers create a writable stream with an initial grant of zero,
        // so no request is sent until playback advances.
        startAudioClock(state, sound);
      } else if (event.event === "ended") {
        state.base = sound.playedTime ?? state.base;
        state.clockStart = hostPerformance.now();
        sound.id = null;
        sound.done = true;
        startAudioClock(state, sound);
        mediaTick(state);
      } else if (event.event === "error") {
        sound.id = null;
        sound.done = true;
        reportError(new Error(`audio: ${event.message}`));
        // Video plays on without sound; audio alone stops.
        if (!state.video) pauseMedia(state.element);
        else startAudioClock(state, sound);
      }
    });
    sound.id = id;
    if (state.video?.presentation) onVideo?.({ type: "video-bind", id: state.video.presentation.id,
      audioId: id, audioStart: sound.streamStart / sound.decoder.sampleRate, time: mediaTime(state) });
  }

  /** Sends about `bytes` of s16le audio (pending samples first, then decoding); at the end, lets it drain. */
  function feedAudio(state, bytes) {
    const sound = state.sound;
    if (!state.playing || sound.id === null || sound.finishing) return;
    // While buffering the output plays what it holds and then nothing, as
    // the video waits; what it asks for is sent when playing resumes.
    if (state.buffering || state.refilling || state.audioPositioning) {
      sound.owed = (sound.owed ?? 0) + bytes;
      return;
    }
    const { channels, sampleRate } = sound.decoder;
    const frameBytes = channels * 2;
    const endSample = Math.round(sound.endTime * sampleRate);
    sound.lastRequest = bytes;
    for (let sent = 0; sent + frameBytes <= bytes;) {
      if (sound.position >= endSample) {
        sound.owed = (sound.owed ?? 0) + bytes - sent;
        void refillMedia(state, sound);
        return;
      }
      let samples = sound.pending;
      sound.pending = null;
      if (!samples) {
        try {
          samples = sound.decoder.nextSamples();
        } catch (error) {
          if (needsMore(sound)) {
            sound.owed = (sound.owed ?? 0) + bytes - sent;
            void refillMedia(state, sound);
            return;
          }
          failMedia(state, error, 3);
          return;
        }
      }
      if (!samples) {
        if (needsMore(sound)) {
          sound.owed = (sound.owed ?? 0) + bytes - sent;
          void refillMedia(state, sound);
          return;
        }
        sound.finishing = true;
        audio.finish(sound.id);
        return;
      }
      const boundaryBytes = Math.max(0, endSample - sound.position) * frameBytes;
      const [taken, remaining] = splitSamples(samples, channels, Math.min(bytes - sent, boundaryBytes));
      if (remaining.length) sound.pending = remaining;
      sound.history.push({ start: sound.position, samples: taken });
      sound.position += taken.length / channels;
      while (sound.history.length > 1 && sound.position - sound.history[1].start > AUDIO_HISTORY_SECONDS * sampleRate) {
        sound.history.shift();
      }
      const pcm = floatToS16(taken);

      // qml handle begin: apply QML AudioOutput gain to the output chunk only
      applyQmlMediaGain(pcm,qmlMediaGains.get(state.element));
      // qml handle end

      audio.write(sound.id, pcm);
      sent += pcm.length;
    }
  }

  /**
   * While bytes keep arriving, waits until `pipe` holds about
   * RESUME_BUFFER_SECONDS more media than `position` needs (estimated from
   * the bytes per second so far). Stops waiting when it is finished, when
   * nothing arrived for RESUME_BUFFER_IDLE_MS (that burst is over: waiting
   * for the next could take long), or after RESUME_BUFFER_MAX_WAIT_MS.
   */
  async function bufferAhead(pipe, position) {
    const deadline = hostPerformance.now() + RESUME_BUFFER_MAX_WAIT_MS;
    // The pipe ends near `position` when starved; early on that says little,
    // so the rate is taken over at least a few seconds (an underestimate).
    const bytesPerSecond = pipe.size / Math.max(4, position);
    const goal = pipe.size + bytesPerSecond * RESUME_BUFFER_SECONDS;
    while (!pipe.done && !pipe.error && pipe.size < goal) {
      const wait = Math.min(RESUME_BUFFER_IDLE_MS, deadline - hostPerformance.now());
      if (wait <= 0) return;
      const size = pipe.size;
      let timer = null;
      await Promise.race([pipe.waitFor(size + 1), new Promise((resolve) => { timer = hostSetTimeout(resolve, wait); })]);
      hostClearTimeout(timer);
      if (pipe.size === size) return;
    }
  }

  /**
   * Seeks `decoder` to the keyframe at or before `seconds` and returns that
   * keyframe's time. wasmpeg seeks to the keyframe without telling its
   * timestamp; taking the target as the position would show every later
   * frame early by the distance to the keyframe, and the picture would trail
   * the sound. Seeks to the same keyframe yield the same first picture, so a
   * binary search over seek targets finds where that keyframe starts (to a
   * frame). The frames from there to the clock are then decoded unshown.
   */
  function seekToKeyframe(decoder, seconds, startTime = 0, bytes = null) {
    return seekVideoKeyframe(decoder, seconds, startTime, bytes);
  }

  /**
   * The decoder ran off the end of the snapshot it was opened on. Freeze the
   * clock, wait for more bytes, reopen on the new snapshot and seek back.
   * Retain the output stream and outstanding credits while positioning the
   * new snapshot. The reported output cursor remains the A/V master clock.
   */
  function refillMedia(state, stalledTrack = null) {
    if (state.refilling) {
      // An audio prefetch may already be waiting for a later segment. If the
      // picture catches its own end meanwhile, it really must wait too.
      if (stalledTrack === state.video && !state.buffering) {
        state.buffering = true;
        stopClock(state, { keepAudio: true });
        if (state.playing) playbackEvent(state, "waiting", mediaEvent);
      }
      return state.refilling;
    }
    const serial = state.seekSerial;
    const resumePresentation = Boolean(state.video?.presentation);
    state.base = mediaTime(state);
    // The audio output stays open through a stall: it plays the PCM it holds
    // and then runs dry, and playing resumes right after that PCM. Closing
    // and reopening it instead loses track of what was heard (a closed
    // stream may still play out its device buffer, which then plays twice).
    const holdAudio = Boolean(stalledTrack && state.sound && state.sound.id != null && !state.sound.finishing);
    // PCM prefetch reaches the end of a snapshot ahead of actual playback.
    // Keep presenting video against measured audio while the controller plays
    // its reserve; a decoder needing bytes is not itself an output underrun.
    const prefetch = holdAudio && stalledTrack === state.sound;
    state.buffering = !prefetch;
    const stall = { at: hostPerformance.now(), base: state.base };
    if (!prefetch) {
      stopClock(state, { keepAudio: holdAudio });
      if (state.playing) playbackEvent(state, "waiting", mediaEvent);
    }
    // The first await lets `job` be assigned before the body looks at it,
    // so a stall inside startMedia can begin a new refill.
    const job = (async () => {
      await Promise.resolve();
      try {
        const pipe = stalledTrack?.pipe ?? state.video?.pipe ?? state.sound?.pipe ?? state.pipe;
        const mark = (pipe?.size ?? 0) + 1;
        // An append may have arrived after this decoder's snapshot was
        // opened but before it reached EOF. Consume that generation now;
        // waiting for one more append creates a segment-sized pause.
        const atEpochEnd = stalledTrack && Number.isFinite(stalledTrack.endTime)
          && (stalledTrack.frameTime !== undefined
            ? stalledTrack.frameTime + 1e-6 >= stalledTrack.endTime
            : stalledTrack.position >= Math.round(stalledTrack.endTime * stalledTrack.decoder.sampleRate));
        const nextEpoch = atEpochEnd ? pipe?.snapshotAt?.(stalledTrack.endTime) : null;
        // Multiple epochs may already be present in one generation. Only a
        // known different snapshot id proves there is another configuration;
        // reaching a timestamp alone must not cause an EOF reopen loop.
        const hasNewSnapshot = Boolean(stalledTrack && pipe
          && (pipe.generation !== stalledTrack.openedGeneration
            || (nextEpoch?.id != null && nextEpoch.id !== stalledTrack.snapshotId)));
        // Some demuxers report EOF at an fMP4/WebM fragment boundary even
        // though the same snapshot contains later fragments. Reopen once at
        // each position/generation; if it makes no progress, wait for append.
        const retry = state.lastRefill;
        const canRetrySnapshot = Boolean(stalledTrack && pipe && !hasNewSnapshot
          && (!retry || retry.pipe !== pipe || retry.generation !== pipe.generation
            || state.base > retry.time + 0.25));
        if (pipe && !pipe.done && !hasNewSnapshot && !canRetrySnapshot) {
          await pipe.waitFor(mark);
          // Starved by a slow network, the smallest refill stalls again at
          // once: buffer a few seconds ahead first, as browsers do before
          // leaving "waiting".
          await bufferAhead(pipe, state.base);
        }
        if (state.seekSerial !== serial || state.document !== page.document || !state.playing) return;
        if (pipe?.error) throw pipe.error;
        // Where the audio is now: it kept playing what it held after the stall.
        const held = holdAudio && state.sound?.id != null ? state.sound : null;
        const writtenEnd = held ? held.position / held.decoder.sampleRate : null;
        if (held) {
          state.base = mediaTime(state);
        } else {
          await skipPlayedAudio(state);
        }
        if (state.seekSerial !== serial || state.document !== page.document || !state.playing) return;
        const time = state.base;
        trace?.(`media stall (${stalledTrack === state.video ? "video" : stalledTrack === state.sound ? "audio" : "end"}): resume at ${time.toFixed(3)}s`
          + `${held ? `, audio held to ${writtenEnd.toFixed(3)}s` : ""} after ${((hostPerformance.now() - stall.at) / 1000).toFixed(2)}s`);
        if (stalledTrack && pipe) state.lastRefill = { pipe, generation: pipe.generation, time };
        // A video decoder still decoding is left alone: reopened, it restarts
        // at a keyframe. A newer shared/download snapshot does not invalidate
        // an audio decoder which can still produce its queued samples. Leave
        // it alone until its own EOF or epoch boundary requests a refill;
        // reopening it here needlessly decodes its entire played prefix.
        const refillVideo = state.hasVideo && (!stalledTrack || stalledTrack === state.video || !state.video);
        const refillAudio = state.hasAudio && audio && (!stalledTrack || stalledTrack === state.sound || !state.sound);
        if (refillVideo) {
          const resumeAt = stalledTrack === state.video && state.video ? Math.min(time, state.video.frameTime) : time;
          // The picture must not go back to the keyframe the decoder restarts at.
          const hideUntil = Math.max(state.video?.shownTime ?? 0, state.video?.hideUntil ?? 0);
          await openVideoDecoder(state, resumeAt);
          state.video.hideUntil = hideUntil;
          if (resumePresentation) {
            // The independent decoder will locate its own current keyframe.
            // Keep the page decoder lazy; if layout/controls now prevent
            // presentation, mediaTick positions it before local decoding.
            state.video.needsLocalPosition = true;
          } else {
            try {
              state.video.frameTime = seekToKeyframe(state.video.decoder, resumeAt, state.video.startTime, state.video.bytes);
            } catch {
              state.video.frameTime = state.video.startTime;
            }
          }
          state.video.done = false;
        }
        if (refillAudio) {
          let opened = false;
          const replacingAudio = Boolean(state.sound);
          try {
            let audioTime = held ? writtenEnd : time;
            if (state.sound && Number.isFinite(state.sound.endTime)
              && state.sound.position >= Math.round(state.sound.endTime * state.sound.decoder.sampleRate)) {
              audioTime = Math.max(audioTime, state.sound.endTime);
            }
            opened = await openAudioDecoder(state, { keepStream: Boolean(held), time: audioTime });
          } catch (error) {
            // A still-growing undecodable prefix returns false above. A
            // genuine failure replacing active audio must stop this media;
            // keeping its exhausted decoder would retry EOF in a busy loop.
            if (replacingAudio || !state.video) throw error;
            reportError(error);
          }
          // A held stream continues right after the PCM it was given.
          if (opened) await positionAudio(state, held ? writtenEnd : time);
          else if (state.playing && !state.sound) ensureAudio(state);
        }
        // Drop this job before startMedia so a new stall can refill.
        if (state.refilling === job) state.refilling = null;
        state.buffering = false;
        if (state.playing && state.seekSerial === serial && state.document === page.document) {
          if (resumePresentation && refillVideo) {
            // Rebind a fresh layer before the first media tick so a resumed
            // presentation does not also decode its prefix on the page thread.
            rasterized.list = null;
            page.resourcePaintDirty = true;
            page.needsPaint = true;
            refresh();
          }
          startMedia(state);
        }
      } catch (error) {
        // A seek or pause can cancel this asynchronous refill while its
        // decoder is still opening. Its later failure belongs to that old
        // operation, not to the playback which replaced it.
        if (state.document === page.document && state.seekSerial === serial && state.playing) {
          failMedia(state, error, 3);
        }
      } finally {
        if (state.refilling === job) {
          state.refilling = null;
          state.buffering = false;
        }
      }
    })();
    state.refilling = job;
    return job;
  }

  function failMedia(state, error, code) {
    state.error = { code, message: String(error?.message ?? error) };
    closeMedia(state);
    state.playing = false;
    if (state.resource) state.resource.playing = false;
    mediaEvent(state, "error");
    reportError(error);
    repaintMedia();
  }

  function endMedia(state) {
    stopClock(state);
    state.ended = true;
    state.base = Number.isFinite(state.duration) ? state.duration : state.base;
    setMediaPlaying(state, false);
    playbackEvent(state, "pause", mediaEvent);
    mediaEvent(state, "ended");
  }

  function setMediaPlaying(state, playing) {
    state.playing = playing;
    state.resource.playing = playing;
    state.resource.time = mediaTime(state);
    if (state.document === page.document) repaintMedia();
  }

  function closeMedia(state) {
    state.wakeProbe?.();
    state.lastProbe = null;
    state.audioOpenSerial = (state.audioOpenSerial ?? 0) + 1;
    state.audioPositioning = null;
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
    for (const state of page.media.values()) {
      closeMedia(state);
      linkMediaSource(state.element, null);
      elementSourceObjects.delete(state.element);
    }
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
    try { absolute = new URL(url, page.document.baseURI || page.url).href; } catch { return null; }
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
    const used = new Set();
    for (const node of tree.nodesById.values()) {
      const value = node.style?.backgroundImage;
      if (!value || seen.has(value) || !value.includes("url(")) continue;
      seen.add(value);
      for (const match of value.matchAll(CSS_URL)) {
        let url;
        try { url = new URL(match[2], document.baseURI || page.url).href; } catch { continue; }
        used.add(url);
        if (page.backgrounds.has(url)) continue;
        const entry = { resource: null, loaded: null };
        page.backgrounds.set(url, entry);
        entry.loaded = loadImageResource(document, url).then((resource) => {
          if (page.backgrounds.get(url) !== entry || document !== page.document) {
            resource.image.delete();
            return;
          }
          entry.resource = resource;
          page.resourcePaintDirty = true;
          page.needsPaint = true;
          scheduleFrame();
        }).catch(() => {
          // A broken background image paints nothing.
        });
      }
    }
    for (const [url, entry] of page.backgrounds) {
      if (used.has(url)) continue;
      entry.resource?.image.delete();
      page.backgrounds.delete(url);
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
    // Infinite feeds remove old DOM images without navigating. The resource
    // WeakMap alone cannot release their explicitly-owned Skia handles.
    for (const element of page.imageElements) {
      if (element.isConnected && element.ownerDocument === document && element.getAttribute("src")) continue;
      const image = page.resources.get(element)?.image;
      if (image) {
        staleImages.push(image);
        page.resourceLayoutDirty = true;
      }
      page.resources.delete(element);
      page.imageElements.delete(element);
      imageRequests.delete(element);
    }
    for (const element of resourceElements.get("images")) {
      const src = element.getAttribute("src");
      const credentials = imageCrossOrigin(element);
      const key = imageRequestKey(src, credentials);
      if (!src || imageRequests.get(element) === key) continue;
      let url;
      try { url = new URL(src, element.baseURI || page.url).href; } catch { continue; }
      const existing = page.resources.get(element);
      if (existing?.requestedURL === url && existing.crossOrigin === credentials) {
        imageRequests.set(element, key);
        continue;
      }
      imageRequests.set(element, key);
      const oldImage = page.resources.get(element)?.image;
      if (oldImage) {
        staleImages.push(oldImage);
        page.resourceLayoutDirty = true;
      }
      page.resources.delete(element);
      beginImageLoad(element, src);
      loadImageResource(document, url, credentials).then((resource) => {
        const { width, height, image } = resource;
        if (generation !== loadGeneration || document !== page.document || element.getAttribute("src") !== src
          || imageCrossOrigin(element) !== credentials) {
          image.delete();
          return;
        }
        page.resources.set(element, resource);
        page.decodedImages.push(image);
        page.imageElements.add(element);
        let node, run;
        for (const candidate of page.renderTree.nodesById.values()) {
          if (candidate.domNode === element) { node = candidate; break; }
        }
        if (node) outer: for (const fragment of page.layout.fragments) {
          for (const candidate of fragment.runs) {
            if (candidate.type === "image" && candidate.nodeId === node.id) { run = candidate; break outer; }
          }
        }
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
          page.resourcePaintDirty = true;
          page.needsPaint = true;
        } else {
          page.dirty = true;
          page.resourceLayoutDirty = true;
        }
        // All arrivals in this rendering opportunity share layout/raster.
        // An onload handler which reads geometry still flushes synchronously.
        finishImageLoad(element, src, { width, height }, type => element.dispatchEvent(new page.window.Event(type)));
        scheduleFrame();
      }).catch((error) => {
        // A failed image retains its fallback replaced-element dimensions.
        trace?.(`image failed ${url}: ${error?.message ?? error}`);
        if (generation === loadGeneration && document === page.document && imageCrossOrigin(element) === credentials) {
          finishImageLoad(element, src, null, type => element.dispatchEvent(new page.window.Event(type)));
        }
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

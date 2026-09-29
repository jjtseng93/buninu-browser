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
import { parseHTMLDocument } from "../happy-dom/parser.js";
import { layoutText } from "../layout/text-layout.js";
import { ScrollViewport } from "../layout/scroll-viewport.js";
import { elementBounds, hitTest, interactiveRegions } from "../input/hit-test.js";
import { RenderTreeBuilder, renderTreeText } from "../render-tree/index.js";
import { StyleEngine } from "../style/computed-style.js";
import { buildDisplayList, visibleItems } from "../paint/display-list.js";
import { backgroundBytes, cropViewport, encodeImage } from "../paint/frame.js";
import { createPageRealm } from "./page-realm.js";
import { MOBILE_USER_AGENT } from "./flags.js";

// Captured at load: in host mode page scripts share this global object.
const hostPerformance = globalThis.performance;
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;

/** How long subresources may take before a preview of the unstyled document is shown. */
export const PREVIEW_DELAY_MS = 300;

const canvasKitDirectory = new URL("../../usr/lib/canvaskit/", import.meta.url);
const fontDirectory = new URL("../../usr/share/fonts/", import.meta.url);

/**
 * @param {{
 *   fetchResource(url: string, kind: "stylesheet" | "image" | "script" | "metadata" | "video"):
 *     Promise<{ ok: boolean, status: number, url: string, contentType: string, body: Uint8Array }>,
 *   requestNavigation?(url: string): void,
 *   reportError?(message: string): void,
 *   pageFetch?(request: object): Promise<object>,
 *   webSockets?: { open(url, protocols, onEvent): number, send(id, data): void, close(id, code, reason): void } | null,
 *   setCookie?(value: string): void,
 *   consoleMessage?: ((level: string, text: string) => void) | null,
 *   trace?: ((text: string) => void) | null,
 *   onFrame?: ((frame: object) => void) | null,
 *   onLifecycle?: ((name: "DOMContentLoaded" | "load", generation: number) => void) | null,
 *   videoDecoder?: object | null,
 * }} options
 */
export async function createPageRenderer({
  fetchResource,
  requestNavigation = () => {},
  reportError = () => {},
  pageFetch = () => Promise.reject(new TypeError("network access is not available")),
  webSockets = null,
  setCookie = () => {},
  consoleMessage = null,
  trace = null,
  onFrame = null,
  onLifecycle = null,
  videoDecoder = null,
  mobile = false,
}) {
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
  const styleEngine = new StyleEngine();
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
    backgroundColor: "rgba(255, 255, 255, 1)",
    resources: new WeakMap(),
    decodedImages: [],
    videos: new Map(),
    realm: null,
    // "off" until the renderer process has set up its sandbox.
    scripting: "off",
    dirty: false,
    userAgent: mobile ? MOBILE_USER_AGENT : "Mozilla/5.0 (X11; Linux) BuninuBrowser/0.0.1",
    // document.cookie as last reported by the controller (non-HttpOnly only).
    cookie: "",
  };

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
      scrollX: viewport.x, scrollY: viewport.y,
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
    if (!onFrame) return;
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
    }, Math.max(50, lastRebuildMs));
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
      const saved = item.fixed || item.clipRect || item.opacity < 1 ? canvas.save() : null;
      try {
        if (item.fixed) canvas.translate(viewport.x * scale, viewport.y * scale);
        if (item.clipRect) canvas.clipRect(deviceRect(item.clipRect), CanvasKit.ClipOp.Intersect, true);
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
        } else {
          const bar = CanvasKit.XYWHRect(rect[0], rect[3] - 24 * scale, rect[2] - rect[0], 24 * scale);
          canvas.drawRect(bar, paint);
          paint.setColor(CanvasKit.Color(255, 255, 255, 1));
          canvas.drawRect(CanvasKit.XYWHRect(rect[0] + 10 * scale, rect[3] - 18 * scale, 4 * scale, 12 * scale), paint);
          canvas.drawRect(CanvasKit.XYWHRect(rect[0] + 17 * scale, rect[3] - 18 * scale, 4 * scale, 12 * scale), paint);
        }
        canvas.restore();
        paint.delete();
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

  function replaceParsedDocument(parsed, styleSheets = [], imageResources = emptyImageResources()) {
    disposeVideos();
    page.realm?.dispose();
    page.realm = null;
    page.window?.happyDOM?.abort?.();
    for (const image of page.decodedImages) image.delete();
    page.window = parsed.window;
    page.document = parsed.document;
    page.title = parsed.document.title;
    page.styleSheets = styleSheets;
    page.resources = imageResources.map;
    initializeVideos(parsed.document, page.resources);
    page.decodedImages = imageResources.decoded;
    imageRequests = new WeakMap();
    const timing = styleAndLayout();
    trace?.(`${page.url}: first style ${timing.style}ms, layout ${timing.layout}ms`);
    viewport.scrollTo(0, 0);
    viewport.setContentSize(page.layout.width, page.layout.height);
    page.hints = [];
    page.hintsVisible = false;
    page.needsPaint = true;
  }

  /** Style, render tree, layout and display list of the current document. */
  function styleAndLayout() {
    const started = hostPerformance.now();
    styleEngine.compute(page.document, page.styleSheets, { width: page.width, height: page.height, mobile });
    page.backgroundColor = documentBackground(page.document, styleEngine);
    page.renderTree = renderTreeBuilder.build(page.document, styleEngine, page.resources);
    const styled = hostPerformance.now();
    page.layout = layoutText(page.renderTree, {
      measureText, fontMetrics, width: page.width, viewportHeight: page.height, x: 0, y: 0,
    });
    page.displayList = buildDisplayList(page.layout, page.renderTree);
    viewport.setContentSize(page.layout.width, page.layout.height);
    return { style: Math.round(styled - started), layout: Math.round(hostPerformance.now() - styled) };
  }

  function rebuildRenderTree(reason = "update") {
    const started = hostPerformance.now();
    page.dirty = false;
    page.needsPaint = true;
    page.title = page.document?.title ?? page.title;
    const timing = styleAndLayout();
    lastRebuildMs = hostPerformance.now() - started;
    trace?.(`${page.url}: restyle and relayout (${reason}) ${Math.round(lastRebuildMs)}ms`
      + ` (style ${timing.style}ms, layout ${timing.layout}ms)`);
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
    const resources = isHtml
      ? Promise.all([loadStyleSheets(parsed.document, url), loadImageResources(parsed.document, url)])
      : Promise.resolve([[], emptyImageResources()]);
    let timer;
    let ready = await Promise.race([
      resources,
      new Promise((resolve) => (timer = hostSetTimeout(resolve, PREVIEW_DELAY_MS, null))),
    ]);
    hostClearTimeout(timer);
    if (!current()) return discard(resources, parsed);
    if (!ready) {
      // Subresources are slow: show the document with the user-agent
      // defaults and its inline <style> sheets meanwhile.
      replaceParsedDocument(parsed, inlineStyleSheets(parsed.document), emptyImageResources());
      render();
      phase("preview");
      commit.resolve();
      ready = await resources;
      if (!current()) return discard(resources);
      phase(`${ready[0].length} stylesheets and ${ready[1].decoded.length} images`);
      // Same document, now styled; the scroll position is kept.
      for (const image of page.decodedImages) image.delete();
      page.styleSheets = ready[0];
      page.resources = ready[1].map;
      initializeVideos(page.document, page.resources);
      page.decodedImages = ready[1].decoded;
      imageRequests = new WeakMap();
      rebuildRenderTree("stylesheets loaded");
    } else {
      phase(`${ready[0].length} stylesheets and ${ready[1].decoded.length} images`);
      replaceParsedDocument(parsed, ready[0], ready[1]);
    }
    phase("style and layout");
    if (!isHtml) {
      page.document.body.textContent = source;
      rebuildRenderTree();
    }
    if (status < 200 || status > 299) {
      page.document.body.textContent = `HTTP ${status} ${statusText}\n${page.document.body.textContent}`;
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
      void hydrateGitHubBranchInfo(generation);
      phase("style, layout and raster after scripts");
    } else {
      finish();
    }
  }

  /** Frees what a superseded load fetched. */
  async function discard(resources, parsed = null) {
    parsed?.window?.happyDOM?.abort?.();
    const [, images] = await resources.catch(() => [[], emptyImageResources()]);
    for (const image of images.decoded) image.delete();
  }

  function inlineStyleSheets(document) {
    return [...document.querySelectorAll("style")].map((element) => element.textContent ?? "");
  }

  /** Brings style, layout and raster up to date; returns whether it repainted. */
  function refresh() {
    if (page.dirty) {
      initializeVideos(page.document, page.resources);
      const staleImages = queueImageResources();
      rebuildRenderTree();
      for (const image of staleImages) {
        const index = page.decodedImages.indexOf(image);
        if (index >= 0) page.decodedImages.splice(index, 1);
        image.delete();
      }
    }
    if (!page.needsPaint) return false;
    render();
    return true;
  }

  function editFocusedText(text, backspace = false) {
    const element = page.document.activeElement;
    if (!element || !["INPUT", "TEXTAREA"].includes(element.tagName) || element.disabled || element.readOnly) return;
    if (element.tagName === "INPUT" && !["text", "search", "url", "email", "tel", "password"].includes(element.type)) return;
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
    element.setSelectionRange?.(start + text.length, start + text.length);
    if (page.realm) page.realm.dispatch(element, new page.window.Event("input", { bubbles: true }));
    page.dirty = true;
  }

  function realmHooks(generation) {
    return {
      touch() {
        page.dirty = true;
        scheduleFrame();
      },
      playVideo,
      pauseVideo,
      videoState,
      lifecycle(name) {
        if (generation === loadGeneration) onLifecycle?.(name, generation);
      },
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
      computedStyle(element) {
        if (!element) return null;
        if (page.dirty) rebuildRenderTree("getComputedStyle");
        return styleEngine.get(element);
      },
      navigate: (url) => requestNavigation(String(url)),
      async fetchScript(url) {
        const response = await fetchResource(url, "script");
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

  /** The border box of an element's layout box in viewport coordinates. */
  function viewportBounds(element) {
    let fixed = false;
    for (let ancestor = element; ancestor && ancestor.nodeType === 1; ancestor = ancestor.parentElement) {
      if (styleEngine.get(ancestor)?.position === "fixed") { fixed = true; break; }
    }
    const scrollX = fixed ? 0 : viewport.x;
    const scrollY = fixed ? 0 : viewport.y;
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
   * Scrolls to the fragment's target (HTML §7.4.6.4); returns whether one
   * was found. `prefix` looks for "<prefix><fragment>" instead.
   */
  function scrollToFragment(href, prefix = "") {
    const url = new URL(href);
    if (!url.hash || url.hash === "#") {
      viewport.scrollTo(0, 0);
      return true;
    }
    let identifier;
    try {
      identifier = prefix + decodeURIComponent(url.hash.slice(1));
    } catch {
      identifier = prefix + url.hash.slice(1);
    }
    const target = page.document.getElementById(identifier)
      ?? [...page.document.getElementsByTagName("a")]
        .find((element) => element.getAttribute("name") === identifier);
    const bounds = target && elementBounds(page.renderTree, page.layout, target);
    if (bounds) viewport.scrollTo(viewport.x, bounds.top);
    return Boolean(target);
  }

  function collectHints() {
    const chars = ["a", "s", "d", "f", "j", "k", "l"];
    const regions = interactiveRegions(page.renderTree, page.layout, viewport, viewport).slice(0, 49);
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
    async showFragment(url) {
      page.url = url;
      const found = scrollToFragment(url);
      // Pages that map fragments to their own targets scroll from a hashchange
      // listener. Rendered Markdown (GitHub, Gitea) prefixes heading ids with
      // "user-content-" and relies on such a script; if the page did not
      // scroll, go to that target instead.
      const before = viewport.y;
      await page.realm?.navigateToFragment(url);
      if (!found && viewport.y === before) scrollToFragment(url, "user-content-");
      render();
    },
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
      refresh();
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
          else if (key === "Enter" && target.tagName === "TEXTAREA") editFocusedText("\n");
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
      editFocusedText(String(text ?? ""));
      refresh();
    },
    scrollOffset() {
      return { x: viewport.x, y: viewport.y };
    },
    /**
     * Clicks at a viewport point: the page receives a click event first, and
     * unless it calls preventDefault() a link under the point is returned for
     * the controller to navigate to.
     */
    click(x, y) {
      refresh();
      const region = hitTest(page.renderTree, page.layout, x, y, viewport, viewport);
      if (!region) return null;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(region.element.tagName)) {
        region.element.focus();
      }
      if (page.realm) {
        const event = new page.window.MouseEvent("click", {
          bubbles: true, cancelable: true, clientX: Number(x), clientY: Number(y), button: 0,
        });
        const prevented = page.realm.dispatch(region.element, event);
        refresh();
        if (prevented) return null;
      }
      if (region.element.tagName === "VIDEO") {
        const state = page.videos.get(region.element);
        if (state?.playing) pauseVideo(region.element);
        else void playVideo(region.element);
        return null;
      }
      const anchor = region.element.closest?.("a[href]");
      if (!anchor) return null;
      const href = new URL(anchor.getAttribute("href"), page.url).href;
      if (href.startsWith("javascript:")) {
        this.runJavaScriptURL(href);
        return null;
      }
      return href;
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
      hostClearTimeout(prepaintTimer);
      hostClearTimeout(frameTimer);
      page.realm?.dispose();
      disposeVideos();
      page.window?.happyDOM?.abort?.();
      for (const image of page.decodedImages) image.delete();
      fontCollection.delete();
      fontProvider.delete();
    },
  };

  replaceDocument("", "about:blank");
  render();
  return api;

  async function loadStyleSheets(document, documentUrl) {
    // Fetched in parallel; the cascade keeps document order.
    const sheets = [...document.querySelectorAll("style, link[rel~='stylesheet']")].map(async (element) => {
      if (element.tagName === "STYLE") return element.textContent ?? "";
      const href = element.getAttribute("href");
      if (!href) return null;
      try {
        const response = await fetchResource(new URL(href, documentUrl).href, "stylesheet");
        return response.ok ? new TextDecoder().decode(response.body) : null;
      } catch {
        // A failed stylesheet must not prevent the document itself from loading.
        return null;
      }
    });
    return (await Promise.all(sheets)).filter((sheet) => sheet !== null);
  }

  async function loadImageResources(document, documentUrl) {
    const map = new WeakMap();
    const decoded = [];
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
      } catch {
        // Broken images keep their fallback replaced-element dimensions.
      }
    }));
    return { map, decoded };
  }

  function initializeVideos(document, resources) {
    for (const element of document.querySelectorAll("video")) {
      if (resources.get(element)) continue;
      const width = Number(element.getAttribute("width")) || 300;
      const height = Number(element.getAttribute("height")) || 150;
      resources.set(element, { width, height, bitmapWidth: 0, bitmapHeight: 0,
        image: null, playing: false, url: "" });
    }
  }

  function videoSource(element) {
    const src = element.getAttribute("src") ?? element.querySelector("source[src]")?.getAttribute("src");
    try { return src ? new URL(src, page.url).href : null; } catch { return null; }
  }

  function videoState(element) {
    const state = page.videos.get(element);
    return { paused: !state?.playing, currentTime: state?.time ?? 0, duration: state?.duration ?? NaN };
  }

  function pauseVideo(element) {
    const state = page.videos.get(element);
    if (!state) return;
    if (!state.decoder) {
      closeVideo(state);
      page.videos.delete(element);
      rasterized.list = null;
      render();
      return;
    }
    state.playing = false;
    state.resource.playing = false;
    hostClearTimeout(state.timer);
    rasterized.list = null;
    render();
  }

  async function playVideo(element) {
    if (!videoDecoder) return;
    const resource = page.resources.get(element);
    const url = videoSource(element);
    if (!resource || !url) return;
    let state = page.videos.get(element);
    if (state?.playing) return;
    if (!state || state.url !== url) {
      if (state) closeVideo(state);
      const generation = loadGeneration;
      state = { element, url, resource, decoder: null, image: null, timer: null, playing: true,
        time: 0, duration: NaN, generation, document: page.document };
      page.videos.set(element, state);
      resource.playing = true;
      rasterized.list = null;
      render();
      try {
        const response = await fetchResource(url, "video");
        if (!response.ok) throw new Error(`video ${url} failed with HTTP ${response.status}`);
        if (generation !== loadGeneration || state.document !== page.document || !state.playing) return;
        state.decoder = await videoDecoder.decode(response.body, { format: "mp4" });
        trace?.(`video decoded ${url}: ${state.decoder.width}x${state.decoder.height}`);
        if (generation !== loadGeneration || state.document !== page.document || !state.playing) {
          state.decoder.close();
          return;
        }
        const metadata = await videoDecoder.probe(response.body);
        state.duration = metadata.duration ?? NaN;
        resource.width = state.decoder.width;
        resource.height = state.decoder.height;
        page.dirty = true;
        refresh();
      } catch (error) {
        if (state.document === page.document) reportError(error);
        closeVideo(state);
        page.videos.delete(element);
        resource.playing = false;
        rasterized.list = null;
        render();
        return;
      }
    } else {
      state.playing = true;
      resource.playing = true;
    }
    drawNextVideoFrame(state);
  }

  function drawNextVideoFrame(state) {
    if (!state.playing || state.generation !== loadGeneration || state.document !== page.document) return;
    const started = hostPerformance.now();
    const width = Math.min(480, state.decoder.width);
    const height = Math.max(1, Math.round(width * state.decoder.height / state.decoder.width));
    const pixels = state.decoder.nextFrame(width, height);
    if (state.time === 0) trace?.(`video first frame ${state.url}: ${pixels?.length ?? 0} bytes`);
    if (!pixels) {
      state.playing = false;
      state.resource.playing = false;
      rasterized.list = null;
      render();
      return;
    }
    const image = CanvasKit.MakeImage({ width, height, alphaType: CanvasKit.AlphaType.Unpremul,
      colorType: CanvasKit.ColorType.RGBA_8888, colorSpace: CanvasKit.ColorSpace.SRGB }, pixels, width * 4);
    if (!image) return pauseVideo(state.element);
    const previous = state.image;
    state.image = image;
    state.resource.image = image;
    state.resource.bitmapWidth = width;
    state.resource.bitmapHeight = height;
    state.time += 1 / (state.decoder.fps || 30);
    rasterized.list = null;
    render();
    previous?.delete();
    if (state.playing) state.timer = hostSetTimeout(() => drawNextVideoFrame(state),
      Math.max(1, 1000 / (state.decoder.fps || 30) - (hostPerformance.now() - started)));
  }

  function closeVideo(state) {
    state.playing = false;
    hostClearTimeout(state.timer);
    state.decoder?.close();
    state.image?.delete();
    state.resource.image = null;
    state.resource.playing = false;
  }

  function disposeVideos() {
    for (const state of page.videos.values()) closeVideo(state);
    page.videos.clear();
  }

  async function hydrateGitHubBranchInfo(generation) {
    if (new URL(page.url).hostname !== "github.com") return;
    const document = page.document;
    const bar = document.querySelector('[data-testid="branch-info-bar"]');
    const embedded = document.querySelector('script[data-target="react-app.embeddedData"]');
    if (!bar?.querySelector(".Skeleton") || !embedded) return;
    try {
      const payload = JSON.parse(embedded.textContent ?? "").payload;
      const fork = payload?.codeViewLayoutRoute?.repo;
      const parent = payload?.sidebarAbout?.repo?.parentRepo;
      const branch = payload?.codeViewRepoRoute?.refInfo;
      if (!fork?.isFork || !parent?.ownerLogin || !parent?.name || branch?.refType !== "branch") return;
      const repoUrl = `https://api.github.com/repos/${encodeURIComponent(parent.ownerLogin)}/${encodeURIComponent(parent.name)}`;
      const compareUrl = `${repoUrl}/compare/HEAD...${encodeURIComponent(fork.ownerLogin)}:${encodeURIComponent(branch.name)}`;
      const [repoResponse, compareResponse] = await Promise.all([
        fetchResource(repoUrl, "metadata"), fetchResource(compareUrl, "metadata"),
      ]);
      if (!repoResponse.ok || !compareResponse.ok) return;
      const decoder = new TextDecoder();
      const defaultBranch = JSON.parse(decoder.decode(repoResponse.body)).default_branch;
      const comparison = JSON.parse(decoder.decode(compareResponse.body));
      const ahead = comparison.ahead_by;
      const behind = comparison.behind_by;
      if (!defaultBranch || !Number.isInteger(ahead) || !Number.isInteger(behind)) return;
      if (generation !== loadGeneration || document !== page.document || !bar.querySelector(".Skeleton")) return;
      const baseName = `${parent.ownerLogin}/${parent.name}:${defaultBranch}`;
      const status = behind > 0
        ? `This branch is ${ahead} commits ahead of and ${behind} commits behind ${baseName}.`
        : `This branch is ${ahead} commits ahead of ${baseName}.`;
      bar.textContent = status;
      page.dirty = true;
      refresh();
    } catch {
      // GitHub's own client can still replace the loading placeholder.
    }
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
        page.dirty = true;
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
  return { map: new WeakMap(), decoded: [] };
}

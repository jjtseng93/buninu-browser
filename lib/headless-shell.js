import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "./cdp-server.js";
import { parseHTMLDocument } from "./happy-dom/parser.js";
import { layoutText } from "./layout/text-layout.js";
import { ScrollViewport } from "./layout/scroll-viewport.js";
import { elementBounds, hitTest, interactiveRegions } from "./input/hit-test.js";
import { RenderTreeBuilder, renderTreeText } from "./render-tree/index.js";
import { StyleEngine } from "./style/computed-style.js";
import { buildDisplayList, visibleItems } from "./paint/display-list.js";

const canvasKitDirectory = new URL("../usr/lib/canvaskit/", import.meta.url);
const fontDirectory = new URL("../usr/share/fonts/", import.meta.url);

export async function runHeadlessShell(args = Bun.argv.slice(2)) {
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
    png: "",
    hints: [],
    hintsVisible: false,
    clickMarker: null,
    styleSheets: [],
    backgroundColor: "rgba(255, 255, 255, 1)",
    resources: new WeakMap(),
    decodedImages: [],
    history: [{ url: "about:blank", x: 0, y: 0 }],
    historyIndex: 0,
  };

  function makeParagraph(text, computedStyle = null, fontSize = computedStyle?.fontSize ?? 16, scale = 1) {
    const color = canvasColor(CanvasKit, computedStyle?.color ?? "rgba(0, 0, 0, 1)");
    const weight = computedStyle?.fontWeight ?? 400;
    const families = resolveFontFamilies(computedStyle?.fontFamily, weight);
    const emojiFontFamilies = [
      ...families.filter((name) => name.includes("Emoji")),
      ...families.filter((name) => !name.includes("Emoji")),
    ];
    const style = new CanvasKit.ParagraphStyle({
      textStyle: {
        color,
        fontFamilies: families,
        fontSize: Math.max(1, Math.round(fontSize * scale)),
        fontStyle: { weight },
        // Roboto is a variable font; static fonts ignore the axis and match by weight.
        fontVariations: [{ axis: "wght", value: weight }],
      },
      maxLines: 1,
    });
    const builder = CanvasKit.ParagraphBuilder.MakeFromFontProvider(style, fontProvider);
    for (const { segment } of graphemes.segment(text || " ")) {
      const emoji = emojiPresentation.test(segment) || segment.includes("\uFE0F");
      if (emoji) {
        builder.pushStyle(CanvasKit.TextStyle({
          color,
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

  function measureText(text, computedStyle = null) {
    if (!text) return 0;
    const paragraph = makeParagraph(text, computedStyle);
    paragraph.layout(100_000);
    // getLongestLine() drops trailing white space, which line breaking needs.
    const width = paragraph.getMaxIntrinsicWidth();
    paragraph.delete();
    return width;
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

  function render() {
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const pixelWidth = Math.max(1, Math.round(width * page.deviceScaleFactor));
    const pixelHeight = Math.max(1, Math.round(height * page.deviceScaleFactor));
    const surface = CanvasKit.MakeSurface(pixelWidth, pixelHeight);
    if (!surface) throw new Error(`Unable to create a ${pixelWidth}x${pixelHeight} CanvasKit surface`);
    const canvas = surface.getCanvas();
    canvas.clear(canvasColor(CanvasKit, page.backgroundColor));
    const scale = page.deviceScaleFactor;
    paintDisplayList(canvas, page.displayList, { x: viewport.x, y: viewport.y, width, height }, scale);
    drawHints(canvas);
    drawClickMarker(canvas);
    surface.flush();
    const image = surface.makeImageSnapshot();
    page.png = Buffer.from(image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100)).toString("base64");
    image.delete();
    surface.delete();
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
    for (const item of visibleItems(displayList, view)) {
      try {
        paintItem(item);
      } catch (error) {
        // One failing item must not take down the page or the browser process.
        if (!paintFailures.has(item.op)) {
          paintFailures.add(item.op);
          console.error(`paint ${item.op} failed:`, error);
        }
      }
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
      } else if (item.op === "drawText") {
        const textStyle = {
          color: item.color, fontSize: item.font.size, fontWeight: item.font.weight, fontFamily: item.font.family,
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

  function drawClickMarker(canvas) {
    if (!page.clickMarker) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.RED);
    canvas.drawCircle(
      page.clickMarker.x * page.deviceScaleFactor,
      page.clickMarker.y * page.deviceScaleFactor,
      7 * page.deviceScaleFactor,
      paint,
    );
    paint.delete();
  }

  function drawHints(canvas) {
    if (!page.hintsVisible) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(255, 238, 0, 1));
    for (const hint of page.hints) {
      canvas.drawRect(CanvasKit.XYWHRect(
        hint.x * page.deviceScaleFactor,
        hint.y * page.deviceScaleFactor,
        Math.max(18, hint.label.length * 10) * page.deviceScaleFactor,
        18 * page.deviceScaleFactor,
      ), paint);
      const builder = CanvasKit.ParagraphBuilder.MakeFromFontProvider(new CanvasKit.ParagraphStyle({
        textStyle: {
          color: CanvasKit.BLACK,
          fontFamilies,
          fontSize: 13 * page.deviceScaleFactor,
        },
        maxLines: 1,
      }), fontProvider);
      builder.addText(hint.label.toUpperCase());
      const paragraph = builder.build();
      builder.delete();
      paragraph.layout(30 * page.deviceScaleFactor);
      canvas.drawParagraph(
        paragraph,
        (hint.x + 2) * page.deviceScaleFactor,
        hint.y * page.deviceScaleFactor,
      );
      paragraph.delete();
    }
    paint.delete();
  }

  function replaceDocument(html, url, styleSheets = [], imageResources = emptyImageResources()) {
    replaceParsedDocument(parseHTMLDocument(html, url), styleSheets, imageResources);
  }

  function replaceParsedDocument(parsed, styleSheets = [], imageResources = emptyImageResources()) {
    page.window?.happyDOM?.abort?.();
    for (const image of page.decodedImages) image.delete();
    page.window = parsed.window;
    page.document = parsed.document;
    page.title = parsed.document.title;
    page.styleSheets = styleSheets;
    page.resources = imageResources.map;
    page.decodedImages = imageResources.decoded;
    styleEngine.compute(parsed.document, styleSheets, { width: page.width, height: page.height });
    page.backgroundColor = documentBackground(parsed.document, styleEngine);
    page.renderTree = renderTreeBuilder.build(parsed.document, styleEngine, page.resources);
    page.layout = layoutText(page.renderTree, { measureText, fontMetrics, width: page.width, viewportHeight: page.height, x: 0, y: 0 });
    page.displayList = buildDisplayList(page.layout);
    viewport.scrollTo(0, 0);
    viewport.setContentSize(page.layout.width, page.layout.height);
    page.hints = [];
    page.hintsVisible = false;
  }

  function rebuildRenderTree() {
    styleEngine.compute(page.document, page.styleSheets, { width: page.width, height: page.height });
    page.backgroundColor = documentBackground(page.document, styleEngine);
    page.renderTree = renderTreeBuilder.build(page.document, styleEngine, page.resources);
    page.layout = layoutText(page.renderTree, { measureText, fontMetrics, width: page.width, viewportHeight: page.height, x: 0, y: 0 });
    page.displayList = buildDisplayList(page.layout);
    viewport.setContentSize(page.layout.width, page.layout.height);
  }

  async function load(url) {
    page.url = url;
    if (url === "about:blank") {
      replaceDocument("", url);
      render();
      return;
    }
    try {
      const response = await fetch(url);
      const source = await response.text();
      const contentType = response.headers.get("content-type") ?? "text/html";
      const html = contentType.toLowerCase().includes("html")
        ? source
        : `<body></body>`;
      const documentUrl = response.url || url;
      const parsed = parseHTMLDocument(html, documentUrl);
      const styleSheets = contentType.toLowerCase().includes("html")
        ? await loadStyleSheets(parsed.document, documentUrl)
        : [];
      const imageResources = contentType.toLowerCase().includes("html")
        ? await loadImageResources(parsed.document, documentUrl)
        : emptyImageResources();
      replaceParsedDocument(parsed, styleSheets, imageResources);
      if (!contentType.toLowerCase().includes("html")) {
        page.document.body.textContent = source;
        rebuildRenderTree();
      }
      if (!response.ok) {
        page.document.body.textContent =
          `HTTP ${response.status} ${response.statusText}\n${page.document.body.textContent}`;
        rebuildRenderTree();
      }
    } catch (error) {
      replaceDocument("", url);
      page.title = "Network error";
      page.document.body.textContent = `${error}`;
      rebuildRenderTree();
    }
    render();
  }

  async function navigate(url) {
    const resolved = new URL(url, page.url).href;
    Object.assign(page.history[page.historyIndex], { x: viewport.x, y: viewport.y });
    const current = new URL(page.url);
    const destination = new URL(resolved);
    const sameDocument = withoutHash(current) === withoutHash(destination);
    if (sameDocument) {
      page.url = resolved;
      scrollToFragment(destination);
      render();
    } else {
      await load(resolved);
      scrollToFragment(destination);
      render();
    }
    page.history.splice(page.historyIndex + 1);
    page.history.push({ url: resolved, x: 0, y: 0 });
    page.historyIndex = page.history.length - 1;
  }

  function scrollToFragment(url) {
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

  async function traverseHistory(index) {
    if (index < 0 || index >= page.history.length || index === page.historyIndex) return;
    Object.assign(page.history[page.historyIndex], { x: viewport.x, y: viewport.y });
    page.historyIndex = index;
    const entry = page.history[index];
    await load(entry.url);
    if (viewport.scrollTo(entry.x, entry.y)) render();
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
        cx: Math.round((rect.left + rect.right) / 2),
        cy: Math.round((rect.top + rect.bottom) / 2),
        element: region.element,
      };
    });
    page.hintsVisible = true;
    render();
    return page.hints.map(({ element, ...hint }) => hint);
  }

  function clearHints() {
    for (const hint of page.hints) hint.element.removeAttribute("data-casty-hint-id");
    page.hints = [];
    page.hintsVisible = false;
    render();
  }

  const context = {
    navigate,
    async reload() {
      await load(page.url);
    },
    async goBack() {
      await traverseHistory(page.historyIndex - 1);
    },
    async goForward() {
      await traverseHistory(page.historyIndex + 1);
    },
    resize(width, height, deviceScaleFactor = 1) {
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
      return page.png;
    },
    title() {
      return page.title;
    },
    scroll(deltaX, deltaY) {
      if (viewport.scrollBy(deltaX, deltaY)) render();
      return { x: viewport.x, y: viewport.y };
    },
    press(key) {
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
    scrollOffset() {
      return { x: viewport.x, y: viewport.y };
    },
    async click(x, y) {
      const region = hitTest(page.renderTree, page.layout, x, y, viewport, viewport);
      const anchor = region?.element.closest?.("a[href]");
      if (!anchor) return null;
      const url = new URL(anchor.getAttribute("href"), page.url).href;
      await navigate(url);
      return { url, title: page.title };
    },
    evaluate(expression) {
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
      if (source.includes("__casty_click_marker")) {
        const x = Number(source.match(/left:(-?[\d.]+)px/)?.[1]);
        const y = Number(source.match(/top:(-?[\d.]+)px/)?.[1]);
        const duration = Number(source.match(/setTimeout\([^,]+,\s*(\d+)\)/s)?.[1]) || 800;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const marker = { x, y };
          page.clickMarker = marker;
          render();
          setTimeout(() => {
            if (page.clickMarker === marker) {
              page.clickMarker = null;
              render();
            }
          }, duration);
        }
        return undefined;
      }
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
      return undefined;
    },
    cdp() {
      return {};
    },
  };

  replaceDocument("", "about:blank");
  render();
  const portArgument = args.find((argument) => argument.startsWith("--remote-debugging-port="));
  const requestedPort = Number(portArgument?.slice("--remote-debugging-port=".length) ?? 9222);
  const server = CdpServer.create(context).listen(requestedPort, "127.0.0.1");
  console.error(`DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);

  const shutdown = () => {
    server.stop(true);
    page.window?.happyDOM?.abort?.();
    for (const image of page.decodedImages) image.delete();
    fontProvider.delete();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;

  async function loadImageResources(document, documentUrl) {
    const map = new WeakMap();
    const decoded = [];
    await Promise.all([...document.querySelectorAll("img")].map(async (element) => {
      const src = element.getAttribute("src");
      if (!src) return;
      try {
        const response = await fetch(new URL(src, documentUrl));
        if (!response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
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
}

function withoutHash(url) {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href;
}

function canvasColor(CanvasKit, value) {
  const match = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  return match
    ? CanvasKit.Color(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]))
    : CanvasKit.BLACK;
}

async function loadStyleSheets(document, documentUrl) {
  const sheets = [];
  for (const element of document.querySelectorAll("style, link[rel~='stylesheet']")) {
    if (element.tagName === "STYLE") {
      sheets.push(element.textContent ?? "");
      continue;
    }
    const href = element.getAttribute("href");
    if (!href) continue;
    try {
      const response = await fetch(new URL(href, documentUrl));
      if (response.ok) sheets.push(await response.text());
    } catch {
      // A failed stylesheet must not prevent the document itself from loading.
    }
  }
  return sheets;
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

import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "./cdp-server.js";
import { parseHTMLDocument } from "./happy-dom/parser.js";
import { layoutText } from "./layout/text-layout.js";
import { ScrollViewport } from "./layout/scroll-viewport.js";
import { hitTest, interactiveRegions } from "./input/hit-test.js";
import { RenderTreeBuilder, renderTreeText } from "./render-tree/index.js";

const canvasKitDirectory = new URL("../usr/lib/canvaskit/", import.meta.url);
const fontDirectory = new URL("../usr/share/fonts/", import.meta.url);

export async function runHeadlessShell(args = Bun.argv.slice(2)) {
  const wasmBinary = await Bun.file(new URL("canvaskit.wasm", canvasKitDirectory)).arrayBuffer();
  const CanvasKit = await CanvasKitInit({ wasmBinary });
  const fontCatalogue = await Bun.file(new URL("fonts.json", fontDirectory)).json();
  const uiFontNames = [fontCatalogue.sets.ui.regular, ...fontCatalogue.sets.ui.fallback];
  const fontBuffers = await Promise.all(uiFontNames.map((name) =>
    Bun.file(new URL(fontCatalogue.fonts[name].file, fontDirectory)).arrayBuffer()));
  const fontManager = CanvasKit.FontMgr.FromData(...fontBuffers);
  if (!fontManager) throw new Error("Unable to load the bundled UI, CJK, and emoji fonts");

  const fontFamilies = uiFontNames.flatMap((name) =>
    fontCatalogue.fonts[name].families ?? [name]);
  const emojiFontFamilies = [
    ...fontFamilies.filter((name) => name.includes("Emoji")),
    ...fontFamilies.filter((name) => !name.includes("Emoji")),
  ];
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const emojiPresentation = /^\p{Emoji_Presentation}/u;
  const renderTreeBuilder = new RenderTreeBuilder();
  const viewport = new ScrollViewport(800, 600);
  const page = {
    url: "about:blank",
    title: "",
    document: null,
    renderTree: null,
    layout: null,
    window: null,
    width: 800,
    height: 600,
    png: "",
    hints: [],
    hintsVisible: false,
    clickMarker: null,
    history: [{ url: "about:blank", x: 0, y: 0 }],
    historyIndex: 0,
  };

  function makeParagraph(text, fontSize = 22) {
    const style = new CanvasKit.ParagraphStyle({
      textStyle: { color: CanvasKit.BLACK, fontFamilies, fontSize },
      maxLines: 1,
    });
    const builder = CanvasKit.ParagraphBuilder.Make(style, fontManager);
    for (const { segment } of graphemes.segment(text || " ")) {
      const emoji = emojiPresentation.test(segment) || segment.includes("\uFE0F");
      if (emoji) {
        builder.pushStyle(CanvasKit.TextStyle({
          color: CanvasKit.BLACK,
          fontFamilies: emojiFontFamilies,
          fontSize,
        }));
      }
      builder.addText(segment);
      if (emoji) builder.pop();
    }
    const paragraph = builder.build();
    builder.delete();
    return paragraph;
  }

  function measureText(text) {
    if (!text) return 0;
    const paragraph = makeParagraph(text);
    paragraph.layout(100_000);
    const width = paragraph.getLongestLine();
    paragraph.delete();
    return width;
  }

  function render() {
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const surface = CanvasKit.MakeSurface(width, height);
    if (!surface) throw new Error(`Unable to create a ${width}x${height} CanvasKit surface`);
    const canvas = surface.getCanvas();
    canvas.clear(CanvasKit.WHITE);
    for (const fragment of page.layout.fragments) {
      const fragmentY = fragment.y - viewport.y;
      if (fragmentY + fragment.height < 0) continue;
      if (fragmentY > height) break;
      const paragraph = makeParagraph(fragment.text);
      paragraph.layout(Math.max(1, width - 32));
      canvas.drawParagraph(paragraph, fragment.x - viewport.x, fragmentY);
      paragraph.delete();
    }
    drawHints(canvas);
    drawClickMarker(canvas);
    surface.flush();
    const image = surface.makeImageSnapshot();
    page.png = Buffer.from(image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100)).toString("base64");
    image.delete();
    surface.delete();
  }

  function drawClickMarker(canvas) {
    if (!page.clickMarker) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.RED);
    canvas.drawCircle(page.clickMarker.x, page.clickMarker.y, 7, paint);
    paint.delete();
  }

  function drawHints(canvas) {
    if (!page.hintsVisible) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(255, 238, 0, 1));
    for (const hint of page.hints) {
      canvas.drawRect(CanvasKit.XYWHRect(hint.x, hint.y, Math.max(18, hint.label.length * 10), 18), paint);
      const builder = CanvasKit.ParagraphBuilder.Make(new CanvasKit.ParagraphStyle({
        textStyle: { color: CanvasKit.BLACK, fontFamilies, fontSize: 13 },
        maxLines: 1,
      }), fontManager);
      builder.addText(hint.label.toUpperCase());
      const paragraph = builder.build();
      builder.delete();
      paragraph.layout(30);
      canvas.drawParagraph(paragraph, hint.x + 2, hint.y);
      paragraph.delete();
    }
    paint.delete();
  }

  function replaceDocument(html, url) {
    page.window?.happyDOM?.abort?.();
    const parsed = parseHTMLDocument(html, url);
    page.window = parsed.window;
    page.document = parsed.document;
    page.title = parsed.document.title;
    page.renderTree = renderTreeBuilder.build(parsed.document);
    page.layout = layoutText(page.renderTree, { measureText });
    viewport.scrollTo(0, 0);
    viewport.setContentSize(page.layout.width, page.layout.height);
    page.hints = [];
    page.hintsVisible = false;
  }

  function rebuildRenderTree() {
    page.renderTree = renderTreeBuilder.build(page.document);
    page.layout = layoutText(page.renderTree, { measureText });
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
      replaceDocument(html, response.url || url);
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
    await load(resolved);
    page.history.splice(page.historyIndex + 1);
    page.history.push({ url: resolved, x: 0, y: 0 });
    page.historyIndex = page.history.length - 1;
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
    resize(width, height) {
      page.width = width;
      page.height = height;
      viewport.resize(width, height);
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
    fontManager.delete();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

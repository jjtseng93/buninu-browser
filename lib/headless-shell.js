import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "./cdp-server.js";
import { parseHTMLDocument } from "./happy-dom/parser.js";
import { layoutText } from "./layout/text-layout.js";
import { ScrollViewport } from "./layout/scroll-viewport.js";
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
  };

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
      const style = new CanvasKit.ParagraphStyle({
        textStyle: { color: CanvasKit.BLACK, fontFamilies, fontSize: 22 },
        maxLines: 1,
      });
      const builder = CanvasKit.ParagraphBuilder.Make(style, fontManager);
      for (const { segment } of graphemes.segment(fragment.text || " ")) {
        const emoji = emojiPresentation.test(segment) || segment.includes("\uFE0F");
        if (emoji) {
          builder.pushStyle(CanvasKit.TextStyle({
            color: CanvasKit.BLACK,
            fontFamilies: emojiFontFamilies,
            fontSize: 22,
          }));
        }
        builder.addText(segment);
        if (emoji) builder.pop();
      }
      const paragraph = builder.build();
      builder.delete();
      paragraph.layout(Math.max(1, width - 32));
      canvas.drawParagraph(paragraph, fragment.x - viewport.x, fragmentY);
      paragraph.delete();
    }
    surface.flush();
    const image = surface.makeImageSnapshot();
    page.png = Buffer.from(image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100)).toString("base64");
    image.delete();
    surface.delete();
  }

  function replaceDocument(html, url) {
    page.window?.happyDOM?.abort?.();
    const parsed = parseHTMLDocument(html, url);
    page.window = parsed.window;
    page.document = parsed.document;
    page.title = parsed.document.title;
    page.renderTree = renderTreeBuilder.build(parsed.document);
    page.layout = layoutText(page.renderTree);
    viewport.scrollTo(0, 0);
    viewport.setContentSize(page.layout.width, page.layout.height);
  }

  function rebuildRenderTree() {
    page.renderTree = renderTreeBuilder.build(page.document);
    page.layout = layoutText(page.renderTree);
    viewport.setContentSize(page.layout.width, page.layout.height);
  }

  async function navigate(url) {
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

  const context = {
    navigate,
    async reload() {
      await navigate(page.url);
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
    evaluate(expression) {
      const source = expression.trim();
      const utilityExpression = source.match(
        /^\(async\(\)=>\{return await \((.*)\)\}\)\(\)$/s,
      )?.[1]?.trim() ?? source;
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

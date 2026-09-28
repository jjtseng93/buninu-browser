import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "./cdp-server.js";
import { documentText, parseHTMLDocument } from "./happy-dom/parser.js";

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
  const page = {
    url: "about:blank",
    title: "",
    text: "",
    document: null,
    window: null,
    width: 800,
    height: 600,
    png: "",
  };

  function wrapText(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .flatMap((line) => {
        const normalized = line.replace(/[\t\f\v ]+/g, " ").trim();
        return normalized
          ? Bun.wrapAnsi(normalized, 40, { hard: true, trim: false }).split("\n")
          : [""];
      });
  }

  function render() {
    const width = Math.max(1, Math.floor(page.width));
    const height = Math.max(1, Math.floor(page.height));
    const surface = CanvasKit.MakeSurface(width, height);
    if (!surface) throw new Error(`Unable to create a ${width}x${height} CanvasKit surface`);
    const canvas = surface.getCanvas();
    canvas.clear(CanvasKit.WHITE);
    let y = 12;
    for (const line of wrapText(page.text)) {
      if (y > height) break;
      const style = new CanvasKit.ParagraphStyle({
        textStyle: { color: CanvasKit.BLACK, fontFamilies, fontSize: 22 },
        maxLines: 1,
      });
      const builder = CanvasKit.ParagraphBuilder.Make(style, fontManager);
      for (const { segment } of graphemes.segment(line || " ")) {
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
      canvas.drawParagraph(paragraph, 16, y);
      paragraph.delete();
      y += 31;
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
    page.text = documentText(parsed.document);
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
        page.text = source;
      }
      if (!response.ok) page.text = `HTTP ${response.status} ${response.statusText}\n${page.text}`;
    } catch (error) {
      replaceDocument("", url);
      page.title = "Network error";
      page.text = `${error}`;
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
      render();
    },
    screenshot() {
      return page.png;
    },
    title() {
      return page.title;
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
      if (/^(?:\(\)\s*=>\s*)?document\.body\.innerText$/.test(utilityExpression)) return page.text;
      if (/^(?:\(\)\s*=>\s*)?document\.documentElement\.outerHTML$/.test(utilityExpression)) {
        return page.document?.documentElement?.outerHTML ?? "";
      }
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

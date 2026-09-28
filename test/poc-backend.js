#!/usr/bin/env bun

import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "../lib/cdp-server.js";

const canvasKitDirectory = new URL("../usr/lib/canvaskit/", import.meta.url);
const fontDirectory = new URL("../usr/share/fonts/", import.meta.url);
const wasmBinary = await Bun.file(new URL("canvaskit.wasm", canvasKitDirectory)).arrayBuffer();
const CanvasKit = await CanvasKitInit({ wasmBinary });
const fontCatalogue = await Bun.file(new URL("fonts.json", fontDirectory)).json();
const uiFontNames = [
  fontCatalogue.sets.ui.regular,
  ...fontCatalogue.sets.ui.fallback,
];
const fontBuffers = await Promise.all(uiFontNames.map((name) =>
  Bun.file(new URL(fontCatalogue.fonts[name].file, fontDirectory)).arrayBuffer()));
const fontManager = CanvasKit.FontMgr.FromData(...fontBuffers);
const fontFamilies = uiFontNames.flatMap((name) =>
  fontCatalogue.fonts[name].families ?? [name]);
const emojiFontFamilies = [
  ...fontFamilies.filter((name) => name.includes("Emoji")),
  ...fontFamilies.filter((name) => !name.includes("Emoji")),
];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation = /^\p{Emoji_Presentation}/u;

if (!fontManager) {
  throw new Error("Unable to load the bundled UI, CJK, and emoji fonts");
}

const page = {
  url: "about:blank",
  title: "",
  text: "",
  width: 800,
  height: 600,
  png: "",
};

function decodeEntities(text) {
  const named = new Map([
    ["amp", "&"], ["apos", "'"], ["gt", ">"], ["lt", "<"],
    ["nbsp", " "], ["quot", '"'],
  ]);
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== "#") return named.get(name.toLowerCase()) ?? entity;
    const hexadecimal = name[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "\uFFFD";
    }
  });
}

function extractPage(html, contentType = "") {
  if (!contentType.toLowerCase().includes("html")) {
    return { title: "", text: html };
  }
  const title = decodeEntities(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
      ?.replace(/<[^>]*>/g, "")
      .trim() ?? "",
  );
  let body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
  body = body
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return { title, text: decodeEntities(body) };
}

function wrapText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const normalized = line.replace(/[\t\f\v ]+/g, " ").trim();
      return normalized ? Bun.wrapAnsi(normalized, 40, { hard: true, trim: false }).split("\n") : [""];
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
      textStyle: {
        color: CanvasKit.BLACK,
        fontFamilies,
        fontSize: 22,
      },
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
  const bytes = image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100);
  page.png = Buffer.from(bytes).toString("base64");
  image.delete();
  surface.delete();
}

async function navigate(url) {
  page.url = url;
  if (url === "about:blank") {
    page.title = "";
    page.text = "";
    render();
    return;
  }
  try {
    const response = await fetch(url);
    const html = await response.text();
    const extracted = extractPage(html, response.headers.get("content-type") ?? "text/html");
    page.title = extracted.title;
    page.text = response.ok
      ? extracted.text
      : `HTTP ${response.status} ${response.statusText}\n${extracted.text}`;
  } catch (error) {
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
  cdp() {
    return {};
  },
};

render();

const portArgument = Bun.argv.find((argument) => argument.startsWith("--remote-debugging-port="));
const requestedPort = Number(portArgument?.slice("--remote-debugging-port=".length) ?? 9222);
const server = CdpServer.create(context).listen(requestedPort, "127.0.0.1");
console.error(`DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);

function shutdown() {
  server.stop(true);
  fontManager.delete();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

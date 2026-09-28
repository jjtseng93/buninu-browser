#!/usr/bin/env bun

import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { CdpServer } from "../lib/cdp-server.js";

const canvasKitDirectory = new URL("../usr/lib/canvaskit/", import.meta.url);
const fontUrl = new URL("../usr/share/fonts/NotoSansCJK-Regular.ttc", import.meta.url);
const wasmBinary = await Bun.file(new URL("canvaskit.wasm", canvasKitDirectory)).arrayBuffer();
const CanvasKit = await CanvasKitInit({ wasmBinary });
const fontData = await Bun.file(fontUrl).arrayBuffer();
const fontManager = CanvasKit.FontMgr.FromData(fontData);
const typeface = fontManager?.matchFamilyStyle("Noto Sans CJK TC", {});

if (!fontManager || !typeface) {
  throw new Error("Unable to load the bundled Noto Sans CJK font");
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
  const paint = new CanvasKit.Paint();
  const font = new CanvasKit.Font(typeface, 22);
  paint.setAntiAlias(true);
  paint.setColor(CanvasKit.BLACK);
  canvas.clear(CanvasKit.WHITE);
  let y = 34;
  for (const line of wrapText(page.text)) {
    if (y > height) break;
    canvas.drawText(line, 16, y, paint, font);
    y += 29;
  }
  surface.flush();
  const image = surface.makeImageSnapshot();
  const bytes = image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100);
  page.png = Buffer.from(bytes).toString("base64");
  image.delete();
  font.delete();
  paint.delete();
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
  typeface.delete();
  fontManager.delete();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);


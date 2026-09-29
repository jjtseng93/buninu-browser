/**
 * The renderer's compositor thread (a Worker), after Chrome's compositor.
 *
 * The main thread runs page scripts, style and layout, and can be busy for
 * seconds. The compositor keeps the latest raster tile and answers
 * screenshots and scrolling on its own channel, so the page stays visible and
 * scrollable while the main thread works.
 *
 * Channel to the controller: fd 3, a socket shared with the controller,
 * newline-delimited JSON (it does not go through the main thread's IPC):
 *   controller -> compositor  { id, method: "screenshot" | "scroll" | "scrollOffset", params }
 *                             (screenshot params: [{ format?: "png" | "jpeg" | "webp", quality? }])
 *   compositor -> controller  { id, result } | { id, error }
 *                             { type: "frame" }   (what the viewport shows changed)
 *
 * Messages with the main thread (postMessage):
 *   main -> compositor  { type: "frame", serial, tile, viewport, content, scroll, scrollEpoch }
 *   compositor -> main  { type: "ready" } | { type: "scroll", x, y } | { type: "frame-ack", serial }
 *
 * Scrolling is owned here: a frame's scroll position is adopted only when
 * the main thread itself scrolled (its scrollEpoch changed), for example for
 * a fragment link, a key press or a new document.
 */
import { ScrollViewport } from "../layout/scroll-viewport.js";
import { cropViewport, encodeImage } from "../paint/frame.js";

const CHANNEL_FD = 3;
const MAX_LINE_BYTES = 1024 * 1024;

const viewport = new ScrollViewport(800, 600);
let tile = null;
let scrollEpoch = -1;
let frameSerial = 0;
let cached = { key: "", data: "" };

const channel = Bun.file(CHANNEL_FD).writer();

function send(message) {
  channel.write(`${JSON.stringify(message)}\n`);
  channel.flush();
}

self.onmessage = ({ data }) => {
  if (data?.type !== "frame") return;
  tile = data.tile;
  frameSerial++;
  viewport.resize(data.viewport.width, data.viewport.height);
  viewport.setContentSize(data.content.width, data.content.height);
  if (data.scrollEpoch !== scrollEpoch) {
    scrollEpoch = data.scrollEpoch;
    viewport.scrollTo(data.scroll.x, data.scroll.y);
  } else {
    // Content size may have changed under a compositor scroll: tell the main
    // thread where the clamped position ended up.
    viewport.scrollTo(viewport.x, viewport.y);
    if (viewport.x !== data.scroll.x || viewport.y !== data.scroll.y) {
      postMessage({ type: "scroll", x: viewport.x, y: viewport.y });
    }
  }
  send({ type: "frame" });
  // Lets the main thread answer the call that produced this frame only once
  // screenshots taken after it will show it.
  postMessage({ type: "frame-ack", serial: data.serial });
};

const methods = {
  async screenshot({ format = "png", quality = 80 } = {}) {
    if (!tile) return "";
    const key = `${frameSerial}:${viewport.x}:${viewport.y}:${format}:${quality}`;
    if (cached.key !== key) {
      const { pixels, width, height } = cropViewport(tile, viewport.x, viewport.y, viewport.width, viewport.height);
      const bytes = await encodeImage(pixels, width, height, { format, quality });
      cached = { key, data: Buffer.from(bytes).toString("base64") };
    }
    return cached.data;
  },
  scroll(deltaX, deltaY) {
    if (viewport.scrollBy(deltaX, deltaY)) {
      postMessage({ type: "scroll", x: viewport.x, y: viewport.y });
      send({ type: "frame" });
    }
    return { x: viewport.x, y: viewport.y };
  },
  scrollOffset() {
    return { x: viewport.x, y: viewport.y };
  },
};

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!Number.isInteger(request?.id) || !Object.hasOwn(methods, request.method)) return;
  try {
    const params = Array.isArray(request.params) ? request.params : [];
    send({ id: request.id, result: await methods[request.method](...params) });
  } catch (error) {
    send({ id: request.id, error: String(error?.message ?? error) });
  }
}

(async () => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.file(CHANNEL_FD).stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      handleLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > MAX_LINE_BYTES) pending = "";
  }
})();

// Bun.Image initialises its codecs on first use; do that before the
// renderer installs seccomp, which forbids opening files.
await encodeImage(new Uint8Array(4), 1, 1);
await encodeImage(new Uint8Array(4), 1, 1, { format: "jpeg" });
postMessage({ type: "ready" });

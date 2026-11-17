/**
 * The renderer's compositor thread (a Worker), after Chrome's compositor.
 *
 * The main thread runs page scripts, style and layout, and can be busy for
 * seconds. The compositor keeps the latest raster tile and answers
 * screenshots and scrolling on its own channel, so the page stays visible and
 * scrollable while the main thread works.
 *
 * Channel to the controller: authenticated loopback socket, with length-prefixed
 * JSON and optional binary pixels (does not go through main-thread IPC):
 *   controller -> compositor  { id, method: "screenshot" | "scroll" | "scrollOffset", params }
 *                             (screenshot params: [{ format?: "png" | "jpeg" | "webp", quality? }])
 *   compositor -> controller  { id, result } | { id, error }
 *                             { type: "frame", scrollOffset: { x, y } }   (the viewport changed)
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
import { rawFrame, captureViewport, encodeImage, encodeImageBase64 } from "../paint/frame.js";
import { FrameCaptureCache } from "../paint/frame-cache.js";
import { FrameLeaseTracker } from "../paint/shared-frame-pool.js";
import { startVideoChannel } from "./video-channel.js";
import { compositeVideo, captureVideoViewport } from "./video-presentation.js";

import {connectCompositor} from './compositor-channel.js';

const viewport = new ScrollViewport(800, 600);
let tile = null;
let scrollEpoch = -1;
let frameSerial = 0;
const captures = new FrameCaptureCache();
const frameLeases = new FrameLeaseTracker(serial => postMessage({ type: "frame-release", serial }));
// Register before awaiting decoder startup: the parent's connect message may
// arrive while the media worker is loading WASM.
const endpointReady = new Promise(resolve => {
  self.onmessage = ({data}) => { if (data?.type === 'connect') resolve(data.endpoint); };
});
const video = await startVideoChannel(() => {
  frameSerial++;
  notifyFrame();
}, report => postMessage({ type: "video-report", ...report }), { releaseRetiredFrames: true });

let channel;
function send(message) {
  const result = message.result;
  if (result?.pixels instanceof Uint8Array) {
    const {pixels,...metadata} = result;
    // This raw result is exclusively owned here. The transport borrows it
    // directly, then releases it after the write completes (or the socket
    // closes); do not detach bytes while a native socket may still use them.
    channel.send({...message,result:metadata},pixels,{takeOwnership:true});
  } else channel.send(message);
}
function notifyFrame() {
  // Snapshot the compositor-owned position with its invalidation. A zero-area
  // screencast needs no pixels and can use this without another socket request.
  send({ type: "frame", scrollOffset: { x: viewport.x, y: viewport.y } });
}
const endpoint = await endpointReady;
channel = await connectCompositor(endpoint, request => { void handleRequest(request); }, () => process.exit(1));

self.onmessage = ({ data }) => {
  if (data?.type === "video-open") { void video.open(data); return; }
  if (data?.type === "video-extend") { video.extend(data); return; }
  if (data?.type === "video-stop") { video.stop(data.id); frameSerial++; return; }
  if (data?.type === "video-bind") { video.bind(data.id, data.audioId, data.audioStart, data.time, data.endTime, data.hasAudio); return; }
  if (data?.type !== "frame") return;
  tile = data.tile;
  frameLeases.replace(data.serial, tile);
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
  notifyFrame();
  // Lets the main thread answer the call that produced this frame only once
  // screenshots taken after it will show it.
  postMessage({ type: "frame-ack", serial: data.serial });
};

// Only private composition/crop buffers are disposable. A full-width crop
// may borrow the immutable raster tile, which remains protected by its lease.
function releaseCapture(frame, composited, captured, retained = null) {
  if (captured && captured.pixels.buffer !== retained && captured.pixels.buffer !== composited.pixels.buffer)
    captured.pixels.buffer.transfer(0);
  if (composited !== frame && composited.pixels.buffer !== retained) composited.pixels.buffer.transfer(0);
}

function videoInCapture(tile, clip) {
  const { rect } = tile.videoLayer;
  const left = Math.round(((clip?.x ?? viewport.x) - tile.x) * tile.scale);
  const top = Math.round(((clip?.y ?? viewport.y) - tile.y) * tile.scale);
  // The encoder scales the crop afterwards; these bounds use source pixels.
  const width = Math.max(1, Math.round((clip?.width ?? Math.floor(viewport.width)) * tile.scale));
  const height = Math.max(1, Math.round((clip?.height ?? Math.floor(viewport.height)) * tile.scale));
  return left < rect.x + rect.width && left + width > rect.x && top < rect.y + rect.height && top + height > rect.y;
}

const methods = {
  async screenshot({ format = "png", quality = 80, optimizeForSpeed = false, clip } = {}) {
    if (!tile) return "";
    if (format === 'rgba' || format === 'bgra') {
      return frameLeases.capture(frame => {
        const visible = frame.videoLayer?.id === video.config?.id
          ? captureVideoViewport(frame, video.frame, viewport.x, viewport.y, viewport.width, viewport.height, clip, format) : null;
        if (visible) {
          // This crop owns its bytes. The normal transport releases them
          // after the socket write completes; the raster tile's lease stays intact.
          try { return rawFrame(visible.pixels, visible.width, visible.height, format,
            {takeOwnership: true, inputFormat: visible.pixelFormat}); }
          catch (error) { visible.pixels.buffer.transfer(0); throw error; }
        }
        const composited = frame.videoLayer?.id === video.config?.id ? compositeVideo(frame, video.frame, format) : frame;
        let captured, result;
        try {
          captured = captureViewport(composited,viewport.x,viewport.y,viewport.width,viewport.height,clip);
          const takeOwnership = captured.pixels.buffer !== frame.pixels.buffer;
          result = rawFrame(captured.pixels,captured.width,captured.height,format,{takeOwnership,inputFormat:composited.pixelFormat ?? "rgba"});
          return result;
        } finally { releaseCapture(frame, composited, captured, result?.pixels.buffer); }
      });
    }
    const key = `${frameSerial}:${viewport.x}:${viewport.y}:${format}:${quality}:${optimizeForSpeed}:${JSON.stringify(clip)}`;
    return captures.get(key, () => frameLeases.capture(async frame => {
      const currentVideo = frame.videoLayer?.id === video.config?.id ? video.frame : null;
      // A frame lease also protects the layer's immutable base during encoding.
      // Outside the video rect it already contains the final pixels.
      const source = currentVideo && frame.videoLayer && !videoInCapture(frame, clip)
        ? { ...frame, pixels: frame.videoLayer.base } : frame;
      const composited = currentVideo && source === frame ? compositeVideo(frame, currentVideo) : source;
      let captured;
      try {
        captured = captureViewport(composited, viewport.x, viewport.y, viewport.width, viewport.height, clip);
        return await encodeImageBase64(captured.pixels, captured.width, captured.height, { format, quality, optimizeForSpeed });
      } finally { releaseCapture(source, composited, captured); }
    }));
  },
  scroll(deltaX, deltaY) {
    if (viewport.scrollBy(deltaX, deltaY)) {
      postMessage({ type: "scroll", x: viewport.x, y: viewport.y });
      notifyFrame();
    }
    return { x: viewport.x, y: viewport.y };
  },
  scrollOffset() {
    return { x: viewport.x, y: viewport.y };
  },
};

async function handleRequest(request) {
  if (request?.type === "audio-timing" && Number.isInteger(request.audioId)) {
    video.timing(request.audioId, request.seconds);
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

// Bun.Image initialises its codecs on first use; do that before the
// renderer installs seccomp, which forbids opening files.
await encodeImage(new Uint8Array(4), 1, 1);
await encodeImage(new Uint8Array(4), 1, 1, { format: "jpeg" });
postMessage({ type: "ready" });

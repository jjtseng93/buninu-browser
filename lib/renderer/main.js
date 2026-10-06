/**
 * Renderer process entry point.
 *
 * Holds one page pipeline and answers the controller over Bun's IPC channel.
 * The renderer has no network access of its own: subresource requests are
 * sent to the controller, which applies its policy and returns the bytes.
 *
 * Protocol (structured-clone messages):
 *   controller -> renderer  { type: "call", id, method, params }
 *                           { type: "fetch-result", id, result | error }
 *                           { type: "fetch-chunk", id, data }   (video/audio stream)
 *                           { type: "fetch-end", id } / { type: "fetch-error", id, error }
 *   renderer -> controller  { type: "ready", sandbox: { seccomp, ses } } (each { installed, reason })
 *                           { type: "result", id, result | error }
 *                           { type: "fetch", id, url, kind }
 *                           { type: "navigate", url, download, fragmentFrom }  (fragmentFrom: the renderer
 *                             already showed this fragment; the scroll offset it left)
 *                           { type: "page-fetch", id, request }  (fetch/XHR, answered by fetch-result)
 *                           { type: "cookie", value }            (document.cookie = value)
 *                           { type: "lifecycle", name, generation } (DOMContentLoaded, load)
 *                           { type: "ws-open", id, url, protocols } / { type: "ws-send", id, data }
 *                           / { type: "ws-close", id, code, reason }  (page WebSockets)
 *   controller -> renderer  { type: "ws-event", id, event, ... }  (open, message, error, close)
 *   renderer -> controller  { type: "audio-open", id, rate, channels, name } / { type: "audio-data", id, data }
 *                           / { type: "audio-finish", id } / { type: "audio-close", id }  (audio output)
 *   controller -> renderer  { type: "audio-event", id, event, ... }  (ready, request with bytes, ended, error)
 *
 * With --compositor, a compositor Worker (compositor.js) answers screenshots
 * and scrolling on fd 3 while this thread is busy; frames go to it with
 * postMessage.
 *
 * Startup order matters for the sandbox:
 *   1. load every module (SES included), start the compositor, and build the page pipeline;
 *   2. warm up everything that loads lazily;
 *   3. install seccomp, which forbids opening files, sockets and processes;
 *   4. lockdown() (SES), after which page scripts run in compartments.
 * bun:ffi (used by seccomp) stops working after lockdown, so 3 precedes 4.
 */
import "../../vendor/ses/dist/ses.mjs";
import { createPageRenderer } from "./page-renderer.js";
import { COMPOSITOR_FLAG, FULL_STYLE_FLAG, MOBILE_FLAG, VERIFY_STYLE_FLAG } from "./flags.js";
import { installSeccomp } from "./seccomp.js";
import { RENDERER_LOG_FLAG } from "../log.js";
import wasmpeg from "../../vendor/wasmpeg/src/js/index.js";
import { createBytePipe } from "../media/byte-pipe.js";

const DANGEROUSLY_ALLOW_HOST_JS = "--dangerously-allow-host-js";

/** Methods the controller may invoke; anything else is ignored. */
const METHODS = new Set([
  "loadDocument", "showFragment", "wheel", "runJavaScriptURL", "url", "scrollTo", "resize", "screenshot", "title",
  "scroll", "press", "type", "scrollOffset", "click", "evaluate", "setUserAgent", "consoleMessages", "whenLoaded",
  "applyCompositorScroll",
]);

// Set when the controller logs this renderer's output (BUNINU_LOG).
const logging = process.argv.includes(RENDERER_LOG_FLAG);
// Straight to stderr: with --dangerously-allow-host-js the page replaces the
// global console, whose messages are themselves forwarded here.
const stderr = process.stderr;
const report = (text) => stderr.write(`${text}\n`);

// As in browsers, a page's unhandled rejection is logged, not fatal.
process.on("unhandledRejection", (reason) => {
  const text = reason?.stack || (reason?.name ? `${reason.name}: ${reason.message}` : String(reason));
  report(`buninu-browser: page error: unhandled rejection: ${logging ? text : text.split("\n")[0]}`);
});

const pendingFetches = new Map();
let nextFetchId = 1;

function fetchResource(url, kind) {
  return new Promise((resolve, reject) => {
    const id = nextFetchId++;
    // The pipe exists before the request is sent, so a chunk that arrives
    // before the head is still part of the body the caller receives.
    const pipe = kind === "video" || kind === "audio" ? createBytePipe() : null;
    pendingFetches.set(id, { resolve, reject, pipe, head: false });
    process.send({ type: "fetch", id, url, kind });
  });
}

function pageFetch(request) {
  return new Promise((resolve, reject) => {
    const id = nextFetchId++;
    pendingFetches.set(id, { resolve, reject });
    process.send({ type: "page-fetch", id, request });
  });
}

// Page WebSockets live in the controller (Bun's WebSocket); events come back as ws-event.
const socketListeners = new Map();
let nextSocketId = 1;
const webSockets = {
  open(url, protocols, onEvent) {
    const id = nextSocketId++;
    socketListeners.set(id, onEvent);
    process.send({ type: "ws-open", id, url, protocols });
    return id;
  },
  send: (id, data) => process.send({ type: "ws-send", id, data }),
  close: (id, code, reason) => process.send({ type: "ws-close", id, code, reason }),
};

// Audio output: PCM goes to the controller, which plays it through PulseAudio.
const audioListeners = new Map();
let nextAudioId = 1;
const audio = {
  open({ rate, channels, name }, onEvent) {
    const id = nextAudioId++;
    audioListeners.set(id, onEvent);
    process.send({ type: "audio-open", id, rate, channels, name });
    return id;
  },
  write: (id, data) => process.send({ type: "audio-data", id, data }),
  finish: (id) => process.send({ type: "audio-finish", id }),
  close(id) {
    audioListeners.delete(id);
    process.send({ type: "audio-close", id });
  },
};

// Workers load their module from disk, so this happens before seccomp.
const compositor = process.argv.includes(COMPOSITOR_FLAG) ? await startCompositor() : null;

// Frames sent to the compositor and the latest one it confirmed.
let framesSent = 0;
let framesAcknowledged = 0;
let frameWaiters = [];

/** Resolves once the compositor holds every frame sent so far. */
function compositorCaughtUp() {
  if (framesAcknowledged >= framesSent) return Promise.resolve();
  const target = framesSent;
  return new Promise((resolve) => frameWaiters.push({ target, resolve }));
}

async function startCompositor() {
  const worker = new Worker(new URL("./compositor.js", import.meta.url).href);
  await new Promise((resolve, reject) => {
    worker.addEventListener("message", resolve, { once: true });
    worker.addEventListener("error", reject, { once: true });
  });
  worker.addEventListener("message", ({ data }) => {
    if (data?.type === "scroll") renderer.applyCompositorScroll(data.x, data.y);
    else if (data?.type === "frame-ack" && Number.isInteger(data.serial)) {
      framesAcknowledged = Math.max(framesAcknowledged, data.serial);
      frameWaiters = frameWaiters.filter((waiter) => {
        if (waiter.target > framesAcknowledged) return true;
        waiter.resolve();
        return false;
      });
    }
  });
  return worker;
}

const renderer = await createPageRenderer({
  fetchResource,
  requestNavigation: (url, download = null, fragmentFrom = null, post = null) => process.send({ type: "navigate", url, download, fragmentFrom, post }),
  requestDownload: ({ url, name, data }) => process.send({ type: "download-data", url, name, data }),
  pageFetch,
  webSockets,
  audio,
  setCookie: (value) => process.send({ type: "cookie", value }),
  reportError: (message) => report(`buninu-browser: page error: ${logging ? message : String(message).split("\n")[0]}`),
  consoleMessage: logging ? (level, text) => report(`page console.${level}: ${text}`) : null,
  trace: logging ? (text) => report(`timing: ${text}`) : null,
  onFrame: compositor ? (frame) => compositor.postMessage({ type: "frame", serial: ++framesSent, ...frame }) : null,
  // Whoever waits for load (a screenshot, say) sees the frame painted at load.
  onLifecycle: (name, generation) => {
    if (name !== "load") process.send({ type: "lifecycle", name, generation });
    else compositorCaughtUp().then(() => process.send({ type: "lifecycle", name, generation }));
  },
  mobile: process.argv.includes(MOBILE_FLAG),
  verifyStyle: process.argv.includes(VERIFY_STYLE_FLAG),
  fullStyle: process.argv.includes(FULL_STYLE_FLAG),
  videoDecoder: wasmpeg,
});
await warmUp();
const allowHostJs = process.argv.includes(DANGEROUSLY_ALLOW_HOST_JS);
const seccomp = allowHostJs
  ? { installed: false, reason: `disabled by ${DANGEROUSLY_ALLOW_HOST_JS}` }
  : installSeccomp();
const ses = allowHostJs ? { installed: false, reason: `disabled by ${DANGEROUSLY_ALLOW_HOST_JS}` } : lockdownRealm();
renderer.setScripting(allowHostJs ? "host" : ses.installed ? "ses" : "off");

/** Hardens the JavaScript realm so page scripts can run in SES compartments. */
function lockdownRealm() {
  try {
    lockdown({
      errorTaming: "safe",
      overrideTaming: "severe",
      consoleTaming: "unsafe",
      localeTaming: "unsafe",
      stackFiltering: "concise",
      // SES otherwise lists every non-standard intrinsic it removes on stderr.
      reporting: "none",
    });
    return { installed: true, reason: null };
  } catch (error) {
    return { installed: false, reason: String(error?.message ?? error) };
  }
}

/**
 * Exercises code paths that read files or initialise state on first use, so
 * they do not need the file system once seccomp is installed.
 */
async function warmUp() {
  await wasmpeg.load();
  new Date().toString();
  new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "full" }).format(0);
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1);
  new Intl.Segmenter(undefined, { granularity: "word" }).segment("warm up");
  crypto.getRandomValues(new Uint8Array(16));
  crypto.randomUUID();
  // 1x1 PNG: initialises Bun.Image's decoder before the sandbox is closed.
  const png = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ), (character) => character.charCodeAt(0));
  await new Bun.Image(png).metadata();
  await renderer.loadDocument({
    url: "about:warm-up",
    source: `<!doctype html><html><head><title>w</title><style>body{color:red}</style></head><body>
      <h1>h</h1><p>p <a href="#x">a</a> <b>b</b> <code>c</code></p><ul><li>l</li></ul><ol><li>o</li></ol>
      <table><tr><td>t</td></tr></table><form><input value="i"><textarea>t</textarea><select><option>o</option></select><button>b</button></form>
      <img alt=""><svg width="1" height="1"><rect width="1" height="1"/></svg><canvas></canvas><template><p>t</p></template>
      <div style="display:flex"><span>f</span></div><div style="display:grid"><span>g</span></div><pre>pre</pre></body></html>`,
  });
  await renderer.resize(800, 600, 1);
  await renderer.screenshot();
  await renderer.loadDocument({ url: "about:blank" });
}

process.on("message", async (message) => {
  if (message?.type === "fetch-chunk") {
    const pending = pendingFetches.get(message.id);
    if (message.data) pending?.pipe?.append(message.data);
    return;
  }
  if (message?.type === "fetch-end") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    pending.pipe?.finish();
    return;
  }
  if (message?.type === "fetch-error") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    const error = new Error(message.error || "media fetch failed");
    pending.pipe?.fail(error);
    if (!pending.head) pending.reject(error);
    return;
  }
  if (message?.type === "fetch-result") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    if (message.error) {
      pendingFetches.delete(message.id);
      const error = new Error(message.error);
      pending.pipe?.fail(error);
      if (!pending.head) pending.reject(error);
      return;
    }
    const result = message.result ?? {};
    if (result.streaming && pending.pipe) {
      pending.head = true;
      pending.resolve({ ...result, body: pending.pipe });
      return;
    }
    pendingFetches.delete(message.id);
    if (pending.pipe) {
      if (result.body) pending.pipe.append(result.body);
      pending.pipe.finish();
      pending.head = true;
      pending.resolve({ ...result, body: pending.pipe });
      return;
    }
    pending.resolve(result);
    return;
  }
  if (message?.type === "audio-event") {
    const listener = audioListeners.get(message.id);
    if (message.event === "ended" || message.event === "error") audioListeners.delete(message.id);
    listener?.(message);
    return;
  }
  if (message?.type === "ws-event") {
    const listener = socketListeners.get(message.id);
    if (message.event === "close") socketListeners.delete(message.id);
    listener?.(message);
    return;
  }
  if (message?.type !== "call" || !METHODS.has(message.method)) return;
  try {
    const result = await renderer[message.method](...(Array.isArray(message.params) ? message.params : []));
    // A screenshot requested after this result must include what the call painted.
    await compositorCaughtUp();
    process.send({ type: "result", id: message.id, result });
  } catch (error) {
    // SES "safe" error taming blanks .stack, so keep name and message too.
    const text = error?.stack || (error?.name ? `${error.name}: ${error.message}` : String(error));
    report(`buninu-browser: renderer ${message.method} failed: ${text}`);
    process.send({ type: "result", id: message.id, error: text });
  }
});

process.on("disconnect", () => {
  renderer.dispose();
  process.exit(0);
});

process.send({ type: "ready", sandbox: { seccomp, ses } });

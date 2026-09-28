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
 *   renderer -> controller  { type: "ready", sandbox: { seccomp: { installed, reason } } }
 *                           { type: "result", id, result | error }
 *                           { type: "fetch", id, url, kind }
 *
 * Startup order matters for the sandbox: build the page pipeline (CanvasKit,
 * fonts), warm up everything that loads lazily, then install seccomp, which
 * forbids opening files, sockets, and new processes from then on.
 */
import { createPageRenderer } from "./page-renderer.js";
import { installSeccomp } from "./seccomp.js";

const DANGEROUSLY_ALLOW_HOST_JS = "--dangerously-allow-host-js";

/** Methods the controller may invoke; anything else is ignored. */
const METHODS = new Set([
  "loadDocument", "showFragment", "url", "scrollTo", "resize", "screenshot", "title",
  "scroll", "press", "scrollOffset", "linkAt", "evaluate",
]);

const pendingFetches = new Map();
let nextFetchId = 1;

function fetchResource(url, kind) {
  return new Promise((resolve, reject) => {
    const id = nextFetchId++;
    pendingFetches.set(id, { resolve, reject });
    process.send({ type: "fetch", id, url, kind });
  });
}

const renderer = await createPageRenderer({ fetchResource });
await warmUp();
const seccomp = process.argv.includes(DANGEROUSLY_ALLOW_HOST_JS)
  ? { installed: false, reason: `disabled by ${DANGEROUSLY_ALLOW_HOST_JS}` }
  : installSeccomp();

/**
 * Exercises code paths that read files or initialise state on first use, so
 * they do not need the file system once seccomp is installed.
 */
async function warmUp() {
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
  if (message?.type === "fetch-result") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  if (message?.type !== "call" || !METHODS.has(message.method)) return;
  try {
    const result = await renderer[message.method](...(Array.isArray(message.params) ? message.params : []));
    process.send({ type: "result", id: message.id, result });
  } catch (error) {
    process.send({ type: "result", id: message.id, error: String(error?.stack ?? error) });
  }
});

process.on("disconnect", () => {
  renderer.dispose();
  process.exit(0);
});

process.send({ type: "ready", sandbox: { seccomp } });

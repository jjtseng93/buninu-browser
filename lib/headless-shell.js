/**
 * Headless shell controller.
 *
 * Owns the CDP endpoint, navigation history, and all network access. Page
 * content (DOM, style, layout, raster, page JavaScript) lives in a renderer
 * subprocess driven through `RendererHost`; the controller never parses or
 * runs page content itself.
 *
 * Sandbox flags: `--no-sandbox` is accepted for Chromium compatibility (casty
 * always passes it) but ignored. Only `--dangerously-allow-host-js` relaxes
 * the renderer sandbox, for every page.
 */
import { CdpServer } from "./cdp-server.js";
import { DEFAULT_DOWNLOAD_DIR, isAttachment, saveDownload, suggestedFilename } from "./download.js";
import { audioDemoDocument, displayDocument } from "./document-types.js";
import { installLog, logFileFromEnv, writeLog } from "./log.js";
import { NetworkService } from "./network/network-service.js";
import { RendererHost } from "./renderer/host.js";
import { MOBILE_FLAG, MOBILE_LAYOUT_WIDTH, MOBILE_USER_AGENT } from "./renderer/flags.js";
import { DESKTOP_USER_AGENT } from "./user-agent.js";

/** Opt-in phone presentation: mobile user agent and touch media features. */
export const MOBILE = "--mobile";

export const DANGEROUSLY_ALLOW_HOST_JS = "--dangerously-allow-host-js";

export async function runHeadlessShell(args = Bun.argv.slice(2)) {
  installLog(logFileFromEnv());
  const allowHostJs = args.includes(DANGEROUSLY_ALLOW_HOST_JS);
  if (args.includes("--no-sandbox")) {
    console.error(`buninu-browser: --no-sandbox is ignored; use ${DANGEROUSLY_ALLOW_HOST_JS} to disable the page sandbox`);
  }
  if (allowHostJs) {
    console.error(`buninu-browser: WARNING ${DANGEROUSLY_ALLOW_HOST_JS}: page scripts are not sandboxed`);
  }

  const mobile = args.includes(MOBILE);
  if (mobile) console.error(`buninu-browser: ${MOBILE}: mobile user agent and touch media features; user agent overrides are ignored`);

  // The endpoint opens while the first renderer starts: a client's first
  // navigation fetches its document meanwhile.
  const browser = await createBrowser({ allowHostJs, mobile, waitForRenderer: false });
  const portArgument = args.find((argument) => argument.startsWith("--remote-debugging-port="));
  const requestedPort = Number(portArgument?.slice("--remote-debugging-port=".length) ?? 9222);
  const server = CdpServer.create(browser.context).listen(requestedPort, "127.0.0.1");
  console.error(`DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
  try {
    await browser.ready;
  } catch (error) {
    server.stop(true);
    browser.close();
    throw error;
  }
  const layerStatus = (layer) => layer?.installed ? "on" : `off (${layer?.reason})`;
  console.error(`buninu-browser: renderer sandbox: seccomp ${layerStatus(browser.sandbox?.seccomp)}, `
    + `ses ${layerStatus(browser.sandbox?.ses)}`);

  const shutdown = () => {
    server.stop(true);
    browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

/**
 * The browser behind the CDP endpoint: navigation, history, the network
 * service, and one renderer process per origin.
 *
 * Every document is committed in a renderer bound to its origin (the final
 * URL after redirects); a cross-origin navigation swaps to a fresh process
 * and closes the old one. A spare renderer is kept warm so the swap does
 * not wait for CanvasKit and fonts to load. Site isolation is by origin
 * because no Public Suffix List is bundled to compute sites.
 *
 * With `waitForRenderer: false` it returns before the first renderer is up
 * (`ready` settles then): navigations fetch their documents meanwhile, and
 * anything that needs a renderer waits for it.
 *
 * @param {{ allowHostJs?: boolean, spareRenderer?: boolean, network?: NetworkService, rendererTimeout?: number,
 *   waitForRenderer?: boolean }} options
 */
export async function createBrowser({
  allowHostJs = false, spareRenderer = true, network = new NetworkService(), rendererTimeout = 30_000, mobile = false,
  waitForRenderer = true,
} = {}) {
  // --mobile fixes the user agent for page requests and navigator.userAgent.
  network.userAgent = mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT;
  const history = [{ url: "about:blank", x: 0, y: 0 }];
  let historyIndex = 0;
  let currentUrl = "about:blank";
  // The current document's response as fetched (raw bytes), for downloads.
  let resource = null;
  let current = null;
  let currentKey = null;
  let spare = null;
  let closed = false;
  // Settles when the first renderer shows about:blank (assigned below).
  let rendererReady = null;
  // Renderer-independent state replayed into every new renderer.
  const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
  let userAgent = null;
  // Listeners for frame and lifecycle notifications (the CDP server).
  const frameListeners = new Set();
  const lifecycleListeners = new Set();
  const downloadListeners = new Set();
  let downloadBehavior = { behavior: "allow", downloadPath: DEFAULT_DOWNLOAD_DIR, eventsEnabled: false };
  // The committed document: its renderer and load generation. Lifecycle
  // messages can arrive before loadDocument returns, so each host records
  // what every generation has reached.
  let committed = { host: null, generation: null };
  const lifecycleSeen = new WeakMap();

  function reachedLifecycle(host, generation) {
    return lifecycleSeen.get(host)?.get(generation) ?? new Set();
  }

  function notify(listeners, ...args) {
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`buninu-browser: listener failed: ${error?.message ?? error}`);
      }
    }
  }

  async function download({ url, body, disposition = "", attributeName = "", totalBytes = 0 }) {
    const guid = crypto.randomUUID();
    const filename = suggestedFilename(url, disposition, attributeName);
    if (downloadBehavior.eventsEnabled) notify(downloadListeners, "willBegin", { guid, url, suggestedFilename: filename });
    if (downloadBehavior.behavior === "deny") {
      if (downloadBehavior.eventsEnabled) notify(downloadListeners, "progress", { guid, state: "canceled", receivedBytes: 0, totalBytes });
      return { downloaded: true };
    }
    try {
      if (downloadBehavior.eventsEnabled) notify(downloadListeners, "progress", { guid, state: "inProgress", receivedBytes: 0, totalBytes });
      const saved = await saveDownload({ url, body, disposition, attributeName,
        filename: downloadBehavior.behavior === "allowAndName" ? guid : null, dir: downloadBehavior.downloadPath });
      if (downloadBehavior.eventsEnabled) notify(downloadListeners, "progress", {
        guid, state: "completed", receivedBytes: saved.bytes, totalBytes: totalBytes || saved.bytes, filePath: saved.path,
      });
      writeLog("download", `${url} -> ${saved.path}`);
      return { downloaded: true, path: saved.path };
    } catch (error) {
      if (downloadBehavior.eventsEnabled) notify(downloadListeners, "progress", { guid, state: "canceled", receivedBytes: 0, totalBytes });
      console.error(`buninu-browser: download failed: ${error?.message ?? error}`);
      return { downloaded: true, error };
    }
  }

  function createHost() {
    const host = new RendererHost({
      network,
      timeout: rendererTimeout,
      args: [...(allowHostJs ? [DANGEROUSLY_ALLOW_HOST_JS] : []), ...(mobile ? [MOBILE_FLAG] : [])],
      // A replacement renderer starts blank; bring the current page back.
      onRestart: async (invoke) => {
        await replayState(invoke);
        await load(currentUrl, invoke);
      },
      // Only the renderer showing the current page may navigate it.
      onNavigate: (url, downloadName, fragmentFrom, post = null) => {
        if (host !== current) return;
        if (fragmentFrom) {
          recordFragment(url, fragmentFrom);
          return;
        }
        navigate(url, { downloadName, post }).catch((error) => console.error(`buninu-browser: navigation failed: ${error.message}`));
      },
      onDownload: ({ url, name, data }) => {
        if (host !== current) return;
        void download({ url, body: data, attributeName: name, totalBytes: data.byteLength });
      },
      onFrame: () => {
        if (host === current) notify(frameListeners);
      },
      onLifecycle: (name, generation) => {
        let generations = lifecycleSeen.get(host);
        if (!generations) lifecycleSeen.set(host, generations = new Map());
        // Only the latest few generations matter.
        if (!generations.has(generation) && generations.size >= 8) generations.delete(generations.keys().next().value);
        const names = generations.get(generation) ?? new Set();
        generations.set(generation, names);
        if (names.has(name)) return;
        names.add(name);
        if (committed.host === host && committed.generation === generation) notify(lifecycleListeners, name);
      },
    });
    return host;
  }

  // With --mobile a viewport wider than a phone is laid out at phone width
  // and scaled up by `pageScale`, so frames keep the client's pixel size and
  // client coordinates are divided by it.
  const pageScale = () => mobile && viewport.width > MOBILE_LAYOUT_WIDTH ? viewport.width / MOBILE_LAYOUT_WIDTH : 1;

  function resizeArguments() {
    const scale = pageScale();
    if (scale === 1) return [viewport.width, viewport.height, viewport.deviceScaleFactor, 1];
    return [MOBILE_LAYOUT_WIDTH, viewport.height / scale, viewport.deviceScaleFactor * scale, scale];
  }

  async function replayState(invoke) {
    await invoke("resize", ...resizeArguments());
    if (userAgent) await invoke("setUserAgent", userAgent);
  }

  function prepareSpare() {
    if (!spareRenderer || closed || spare) return;
    spare = createHost();
    spare.start().catch(() => {
      spare = null;
    });
  }

  /** The renderer for a URL's origin, swapping processes on an origin change. */
  async function rendererFor(url) {
    const key = originKey(url);
    if (current && key === currentKey) return current;
    const next = spare ?? createHost();
    spare = null;
    await next.start();
    await replayState((method, ...params) => next.call(method, ...params));
    const previous = current;
    current = next;
    currentKey = key;
    previous?.close();
    prepareSpare();
    return current;
  }

  const call = async (method, ...params) => {
    await rendererReady;
    return current.call(method, ...params);
  };

  /**
   * Applies viewport or user agent state the renderer is told about. Before
   * the first renderer is up there is nothing to wait for: it starts with the
   * state (replayState), and the latest state is applied again once it is.
   */
  function applyState(method, args) {
    if (current) return current.call(method, ...args());
    rendererReady.then(() => current?.call(method, ...args())).catch(() => {});
    return undefined;
  }

  /**
   * Fetches a top-level document, then commits it in the renderer for its
   * final origin. `invoke` pins the renderer (used when restoring a
   * restarted renderer).
   */
  async function load(url, invoke = null, downloadName = null, post = null) {
    const started = performance.now();
    if (downloadName !== null && resource && withoutHash(url) === withoutHash(resource.url)) {
      return download({ url: resource.url, body: resource.body, attributeName: downloadName, totalBytes: resource.body.byteLength });
    }
    let document;
    if (url === "about:blank") {
      document = { url };
    } else if (url === "about:audio") {
      document = { url, ...audioDemoDocument() };
    } else {
      try {
        const target = new URL(url);
        const response = ["http:", "https:"].includes(target.protocol)
          ? await network.navigate(target.href, { post, onResponse: (raw, finalUrl) => {
            if (!raw.ok || (downloadName === null && !isAttachment(raw.headers.get("content-disposition")))) return null;
            return download({ url: finalUrl, body: raw.body, disposition: raw.headers.get("content-disposition") ?? "",
              attributeName: downloadName ?? "", totalBytes: Number(raw.headers.get("content-length")) || 0 });
          } })
          : await localDocument(target);
        if (response.downloaded) return response;
        if (downloadName !== null) return download({ url: response.url, body: response.body,
          attributeName: downloadName, totalBytes: response.body.byteLength });
        resource = { url: response.url, contentType: response.contentType ?? "", body: response.body };
        // Non-HTML responses (images, JSON, TOML, text...) are shown through a generated page.
        const shown = displayDocument({ url: response.url, contentType: response.contentType, body: response.body });
        document = {
          url: response.url,
          source: shown.source,
          contentType: shown.contentType,
          status: response.status,
          statusText: response.statusText,
          cookie: network.documentCookie(response.url),
        };
      } catch (error) {
        document = { url, error: String(error) };
      }
    }
    if (document.url === "about:blank" || document.url === "about:audio" || document.error) resource = null;
    currentUrl = document.url;
    const fetched = performance.now();
    writeLog("navigation", `${url}: ${document.error ?? `HTTP ${document.status ?? 200}`}`
      + `${document.url === url ? "" : ` -> ${document.url}`} in ${Math.round(fetched - started)}ms`);
    if (!invoke) await rendererReady;
    const host = invoke ? current : await rendererFor(document.url);
    const generation = await (invoke ?? ((method, ...params) => host.call(method, ...params)))("loadDocument", document);
    committed = { host, generation };
    for (const name of reachedLifecycle(host, generation)) notify(lifecycleListeners, name);
    writeLog("navigation", `${document.url}: first paint in ${Math.round(performance.now() - fetched)}ms`);
  }

  // Screenshots and scrolling go to the compositor thread, so they are
  // answered even while the renderer's main thread is busy.
  const composite = async (method, ...params) => {
    await rendererReady;
    return current.composite(method, ...params);
  };

  async function rememberScroll() {
    // Before the first renderer is up nothing has been shown or scrolled.
    if (!current) return;
    const offset = await composite("scrollOffset");
    Object.assign(history[historyIndex], { x: offset.x, y: offset.y });
  }

  async function navigate(url, { downloadName = null, post = null } = {}) {
    const resolved = new URL(url, currentUrl).href;
    // A javascript: URL runs in the current document; history does not change.
    if (resolved.startsWith("javascript:")) {
      await call("runJavaScriptURL", resolved);
      return;
    }
    await rememberScroll();
    let shown = resolved;
    if (!post && downloadName === null && withoutHash(resolved) === withoutHash(currentUrl)) {
      currentUrl = resolved;
    } else {
      const result = await load(resolved, null, downloadName, post);
      if (result?.downloaded) return null;
      // The document is at the URL redirects ended on; the request's fragment
      // carries over to it unless it has its own (Fetch §4.4, HTML §7.4.6).
      shown = withFragment(currentUrl, resolved);
      currentUrl = shown;
    }
    await call("showFragment", shown);
    history.splice(historyIndex + 1);
    history.push({ url: shown, x: 0, y: 0 });
    historyIndex = history.length - 1;
  }

  /** The renderer already navigated to a fragment of its document; only history changes. */
  function recordFragment(url, from) {
    if (withoutHash(url) !== withoutHash(currentUrl)) return;
    Object.assign(history[historyIndex], { x: from.x, y: from.y });
    currentUrl = url;
    history.splice(historyIndex + 1);
    history.push({ url, x: 0, y: 0 });
    historyIndex = history.length - 1;
  }

  async function traverseHistory(index) {
    if (index < 0 || index >= history.length || index === historyIndex) return;
    await rememberScroll();
    historyIndex = index;
    const entry = history[index];
    await load(entry.url);
    await call("scrollTo", entry.x, entry.y);
  }

  const context = {
    navigate,
    setDownloadBehavior({ behavior = "allow", downloadPath = DEFAULT_DOWNLOAD_DIR, eventsEnabled = false } = {}) {
      if (!["allow", "allowAndName", "default", "deny"].includes(behavior)) throw new TypeError(`Unsupported download behavior ${behavior}`);
      downloadBehavior = { behavior, downloadPath, eventsEnabled: Boolean(eventsEnabled) };
    },
    onDownload(listener) {
      downloadListeners.add(listener);
      return () => downloadListeners.delete(listener);
    },
    reload: () => load(currentUrl),
    goBack: () => traverseHistory(historyIndex - 1),
    goForward: () => traverseHistory(historyIndex + 1),
    resize(width, height, deviceScaleFactor = 1) {
      Object.assign(viewport, { width, height, deviceScaleFactor });
      return applyState("resize", resizeArguments);
    },
    setUserAgent(value) {
      // With --mobile the phone user agent stays (casty, for one, overrides it with a desktop one).
      if (mobile) return undefined;
      userAgent = typeof value === "string" && value ? value : null;
      network.userAgent = userAgent;
      return userAgent ? applyState("setUserAgent", () => [userAgent]) : undefined;
    },
    screenshot: (options = {}) => composite("screenshot", {
      format: options.format === "jpeg" || options.format === "webp" ? options.format : "png",
      quality: Number.isFinite(options.quality) ? options.quality : 80,
    }),
    title: () => call("title"),
    /**
     * The document's response body as it arrived (CDP Page.getResourceContent),
     * for the current document's URL with or without its fragment; else null.
     */
    resourceContent(url = currentUrl) {
      if (!resource) return null;
      let wanted;
      try {
        wanted = withoutHash(String(url));
      } catch {
        return null;
      }
      return wanted === withoutHash(resource.url) || wanted === withoutHash(currentUrl)
        ? { url: resource.url, contentType: resource.contentType, body: resource.body }
        : null;
    },
    /**
     * Scrolls by a wheel delta. With the pointer's viewport position, the
     * scroll container under it (an element, an iframe's document) scrolls
     * first; the page scrolls when nothing there takes it.
     */
    async scroll(deltaX, deltaY, at = null) {
      const scale = pageScale();
      let left = { x: deltaX / scale, y: deltaY / scale };
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
        left = await call("wheel", at.x / scale, at.y / scale, left.x, left.y) ?? left;
        if (!left.x && !left.y) return undefined;
      }
      return composite("scroll", left.x, left.y);
    },
    press: (key, options) => call("press", key, options),
    type: (text) => call("type", text),
    scrollOffset: () => composite("scrollOffset"),
    /** Calls `listener()` whenever what the viewport shows changes; returns an unsubscribe function. */
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    /** Calls `listener(name)` for DOMContentLoaded and load of the committed document. */
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    /** Lifecycle events the committed document has already reached. */
    lifecycleState() {
      return [...reachedLifecycle(committed.host, committed.generation)];
    },
    async click(x, y) {
      const clicked = await call("click", x / pageScale(), y / pageScale());
      const href = typeof clicked === "string" ? clicked : clicked?.url;
      if (typeof href !== "string") return null;
      if (clicked.fragmentFrom) {
        recordFragment(href, clicked.fragmentFrom);
        return { url: href, title: await call("title") };
      }
      const result = await navigate(href, { downloadName: typeof clicked === "object" ? clicked.download ?? null : null });
      return result === null ? null : { url: href, title: await call("title") };
    },
    evaluate: (expression) => call("evaluate", String(expression)),
    cdp() {
      return {};
    },
  };

  // The spare starts with the first renderer rather than after it, ready
  // for the first navigation to an origin.
  rendererReady = (async () => {
    const first = rendererFor("about:blank");
    prepareSpare();
    await first;
    await current.call("loadDocument", { url: "about:blank" });
  })();
  if (waitForRenderer) await rendererReady;
  else rendererReady.catch(() => {}); // the caller awaits `ready`

  return {
    context,
    network,
    ready: rendererReady,
    get sandbox() {
      return current?.sandbox ?? null;
    },
    /** Diagnostics: the process currently rendering the page, and the warm spare. */
    get rendererPid() {
      return current?.pid ?? null;
    },
    get sparePid() {
      return spare?.pid ?? null;
    },
    close() {
      closed = true;
      current?.close();
      spare?.close();
      current = null;
      spare = null;
    },
  };
}

/** Process-isolation key: the origin for http(s), one shared key for opaque origins. */
function originKey(url) {
  try {
    const target = new URL(url);
    return ["http:", "https:"].includes(target.protocol) ? target.origin : "opaque";
  } catch {
    return "opaque";
  }
}

/** data: (and other non-network) documents are read locally without cookies. */
async function localDocument(url) {
  const response = await fetch(url);
  return {
    url: url.href,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") ?? "text/html",
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/** `url`, with the fragment of `requested` when it has none of its own. */
function withFragment(url, requested) {
  try {
    const target = new URL(url);
    const hash = new URL(requested).hash;
    if (!target.hash && hash) target.hash = hash;
    return target.href;
  } catch {
    return url;
  }
}

function withoutHash(href) {
  const copy = new URL(href);
  copy.hash = "";
  return copy.href;
}

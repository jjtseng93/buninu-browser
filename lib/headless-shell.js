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
import { NetworkService } from "./network/network-service.js";
import { RendererHost } from "./renderer/host.js";

export const DANGEROUSLY_ALLOW_HOST_JS = "--dangerously-allow-host-js";

export async function runHeadlessShell(args = Bun.argv.slice(2)) {
  const allowHostJs = args.includes(DANGEROUSLY_ALLOW_HOST_JS);
  if (args.includes("--no-sandbox")) {
    console.error(`buninu-browser: --no-sandbox is ignored; use ${DANGEROUSLY_ALLOW_HOST_JS} to disable the page sandbox`);
  }
  if (allowHostJs) {
    console.error(`buninu-browser: WARNING ${DANGEROUSLY_ALLOW_HOST_JS}: page scripts are not sandboxed`);
  }

  const browser = await createBrowser({ allowHostJs });
  const layerStatus = (layer) => layer?.installed ? "on" : `off (${layer?.reason})`;
  console.error(`buninu-browser: renderer sandbox: seccomp ${layerStatus(browser.sandbox?.seccomp)}, `
    + `ses ${layerStatus(browser.sandbox?.ses)}`);

  const portArgument = args.find((argument) => argument.startsWith("--remote-debugging-port="));
  const requestedPort = Number(portArgument?.slice("--remote-debugging-port=".length) ?? 9222);
  const server = CdpServer.create(browser.context).listen(requestedPort, "127.0.0.1");
  console.error(`DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);

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
 * @param {{ allowHostJs?: boolean, spareRenderer?: boolean, network?: NetworkService, rendererTimeout?: number }} options
 */
export async function createBrowser({
  allowHostJs = false, spareRenderer = true, network = new NetworkService(), rendererTimeout = 30_000,
} = {}) {
  const history = [{ url: "about:blank", x: 0, y: 0 }];
  let historyIndex = 0;
  let currentUrl = "about:blank";
  let current = null;
  let currentKey = null;
  let spare = null;
  let closed = false;
  // Renderer-independent state replayed into every new renderer.
  const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
  let userAgent = null;

  function createHost() {
    const host = new RendererHost({
      network,
      timeout: rendererTimeout,
      args: allowHostJs ? [DANGEROUSLY_ALLOW_HOST_JS] : [],
      // A replacement renderer starts blank; bring the current page back.
      onRestart: async (invoke) => {
        await replayState(invoke);
        await load(currentUrl, invoke);
      },
      // Only the renderer showing the current page may navigate it.
      onNavigate: (url) => {
        if (host !== current) return;
        navigate(url).catch((error) => console.error(`buninu-browser: navigation failed: ${error.message}`));
      },
    });
    return host;
  }

  async function replayState(invoke) {
    await invoke("resize", viewport.width, viewport.height, viewport.deviceScaleFactor);
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

  const call = (method, ...params) => current.call(method, ...params);

  /**
   * Fetches a top-level document, then commits it in the renderer for its
   * final origin. `invoke` pins the renderer (used when restoring a
   * restarted renderer).
   */
  async function load(url, invoke = null) {
    currentUrl = url;
    let document;
    if (url === "about:blank") {
      document = { url };
    } else {
      try {
        const target = new URL(url);
        const response = ["http:", "https:"].includes(target.protocol)
          ? await network.navigate(target.href)
          : await localDocument(target);
        document = {
          url: response.url,
          source: new TextDecoder().decode(response.body),
          contentType: response.contentType || "text/html",
          status: response.status,
          statusText: response.statusText,
          cookie: network.documentCookie(response.url),
        };
      } catch (error) {
        document = { url, error: String(error) };
      }
    }
    currentUrl = document.url;
    if (invoke) await invoke("loadDocument", document);
    else await (await rendererFor(document.url)).call("loadDocument", document);
  }

  async function rememberScroll() {
    const offset = await call("scrollOffset");
    Object.assign(history[historyIndex], { x: offset.x, y: offset.y });
  }

  async function navigate(url) {
    const resolved = new URL(url, currentUrl).href;
    await rememberScroll();
    if (withoutHash(resolved) === withoutHash(currentUrl)) {
      currentUrl = resolved;
    } else {
      await load(resolved);
    }
    await call("showFragment", resolved);
    history.splice(historyIndex + 1);
    history.push({ url: resolved, x: 0, y: 0 });
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
    reload: () => load(currentUrl),
    goBack: () => traverseHistory(historyIndex - 1),
    goForward: () => traverseHistory(historyIndex + 1),
    resize(width, height, deviceScaleFactor = 1) {
      Object.assign(viewport, { width, height, deviceScaleFactor });
      return call("resize", width, height, deviceScaleFactor);
    },
    setUserAgent(value) {
      userAgent = typeof value === "string" && value ? value : null;
      network.userAgent = userAgent;
      return userAgent ? call("setUserAgent", userAgent) : undefined;
    },
    screenshot: () => call("screenshot"),
    title: () => call("title"),
    scroll: (deltaX, deltaY) => call("scroll", deltaX, deltaY),
    press: (key) => call("press", key),
    scrollOffset: () => call("scrollOffset"),
    async click(x, y) {
      const href = await call("click", x, y);
      if (typeof href !== "string") return null;
      await navigate(href);
      return { url: href, title: await call("title") };
    },
    evaluate: (expression) => call("evaluate", String(expression)),
    cdp() {
      return {};
    },
  };

  await rendererFor("about:blank");
  await current.call("loadDocument", { url: "about:blank" });

  return {
    context,
    network,
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

function withoutHash(href) {
  const copy = new URL(href);
  copy.hash = "";
  return copy.href;
}

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

  const history = [{ url: "about:blank", x: 0, y: 0 }];
  let historyIndex = 0;
  let currentUrl = "about:blank";
  const renderer = new RendererHost({
    args: allowHostJs ? [DANGEROUSLY_ALLOW_HOST_JS] : [],
    // A replacement renderer starts blank; bring the current page back.
    onRestart: (call) => load(currentUrl, call),
  });
  await renderer.start();
  const seccomp = renderer.sandbox?.seccomp;
  console.error(`buninu-browser: renderer sandbox: seccomp ${seccomp?.installed ? "on" : `off (${seccomp?.reason})`}`);

  const call = (method, ...params) => renderer.call(method, ...params);

  /** Fetches a top-level document and commits it in the renderer. */
  async function load(url, invoke = call) {
    currentUrl = url;
    if (url === "about:blank") {
      await invoke("loadDocument", { url });
      return;
    }
    try {
      const response = await fetch(url);
      await invoke("loadDocument", {
        url: response.url || url,
        source: await response.text(),
        contentType: response.headers.get("content-type") ?? "text/html",
        status: response.status,
        statusText: response.statusText,
      });
      currentUrl = response.url || url;
    } catch (error) {
      await invoke("loadDocument", { url, error: String(error) });
    }
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
    resize: (width, height, deviceScaleFactor = 1) => call("resize", width, height, deviceScaleFactor),
    screenshot: () => call("screenshot"),
    title: () => call("title"),
    scroll: (deltaX, deltaY) => call("scroll", deltaX, deltaY),
    press: (key) => call("press", key),
    scrollOffset: () => call("scrollOffset"),
    async click(x, y) {
      const href = await call("linkAt", x, y);
      if (typeof href !== "string") return null;
      await navigate(href);
      return { url: href, title: await call("title") };
    },
    evaluate: (expression) => call("evaluate", String(expression)),
    cdp() {
      return {};
    },
  };

  const portArgument = args.find((argument) => argument.startsWith("--remote-debugging-port="));
  const requestedPort = Number(portArgument?.slice("--remote-debugging-port=".length) ?? 9222);
  const server = CdpServer.create(context).listen(requestedPort, "127.0.0.1");
  console.error(`DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);

  const shutdown = () => {
    server.stop(true);
    renderer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

function withoutHash(href) {
  const copy = new URL(href);
  copy.hash = "";
  return copy.href;
}

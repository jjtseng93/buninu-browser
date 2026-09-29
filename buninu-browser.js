#!/usr/bin/env bun

/**
 * Buninu Browser executable and public module entry point.
 *
 * Keep import-time behavior side-effect free. CLI startup belongs behind the
 * import.meta.main guard so tests and embedders can import the same file.
 */
import packageInfo from "./package.json" with { type: "json" };

export {
  CdpServer,
  isOriginAllowed,
  isSafeHostHeader,
  parseAllowedOrigins,
} from "./lib/cdp-server.js";

export const runtimeRoot = new URL("./usr/", import.meta.url);
export const canvasKitRoot = new URL("./usr/lib/canvaskit/", import.meta.url);
export const fontRoot = new URL("./usr/share/fonts/", import.meta.url);

export { parseHTMLDocument } from "./lib/happy-dom/parser.js";
export { layoutText } from "./lib/layout/text-layout.js";
export { ScrollViewport } from "./lib/layout/scroll-viewport.js";
export { elementBounds, hitTest, interactiveRegions } from "./lib/input/hit-test.js";
export { computeElementStyle, parseDeclarations, StyleEngine } from "./lib/style/computed-style.js";
export { RenderTreeBuilder, renderTreeText } from "./lib/render-tree/index.js";

export async function main(args = Bun.argv.slice(2)) {
  const has = (...names) => names.some((name) => args.includes(name));
  if (has("--version", "-V", "-version")) {
    console.log(`buninu-browser ${packageInfo.version}`);
    return 0;
  }

  if (has("--help", "-h", "-help")) {
    console.log(`Buninu Browser ${packageInfo.version}

Usage: buninu-browser [options]

Options:
  --remote-debugging-port=<port>  CDP port (0 picks a free one; default 9222)
  --no-sandbox                    Accepted for Chromium compatibility and ignored
  --dangerously-allow-host-js     Turn the page sandbox off for every page
  --mobile                        Present as a phone: mobile user agent and touch media
                                  features (hover: none, pointer: coarse); user agent
                                  overrides over CDP are ignored
  --version, -V                   Print the version
  --help, -h                      Print this help

Environment:
  BUNINU_LOG=1                    Also log to ./buninu-browser.log (page errors,
                                  console output, timings, renderer crashes)
  BUNINU_LOG=<path>               Log to that file instead`);
    return 0;
  }

  const { runHeadlessShell } = await import("./lib/headless-shell.js");
  await runHeadlessShell(args);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}

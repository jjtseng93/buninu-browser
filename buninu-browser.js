#!/usr/bin/env bun

/**
 * Buninu Browser executable and public module entry point.
 *
 * Keep import-time behavior side-effect free. CLI startup belongs behind the
 * import.meta.main guard so tests and embedders can import the same file.
 */

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
export { RenderTreeBuilder, renderTreeText } from "./lib/render-tree/index.js";

export async function main(args = Bun.argv.slice(2)) {
  if (args.includes("--version")) {
    console.log("buninu-browser 0.0.0");
    return 0;
  }

  if (args.includes("--help")) {
    console.log(`Buninu Browser 0.0.0

Usage: buninu-browser [options]

Options:
  --version  Print the version
  --help     Print this help`);
    return 0;
  }

  const { runHeadlessShell } = await import("./lib/headless-shell.js");
  await runHeadlessShell(args);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}

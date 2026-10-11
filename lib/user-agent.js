import packageInfo from "../package.json" with { type: "json" };

export const BROWSER_PRODUCT = `Buninu/${packageInfo.version}`;
// Compatibility identities, not the version of this engine. Bun runs
// JavaScriptCore, so a WebKit profile can avoid a V8/JavaScriptCore mismatch.
// Keep the complete profile together: changing just the UA leaves conflicting
// vendor and User-Agent Client Hints exposed to scripts.
export const WEBKIT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
// Chrome 154 compatibility profile (2026-09-22).
export const CHROMIUM_VERSION = "154.0.8037.57";

export function desktopUserAgent(platform = process.platform, arch = process.arch) {
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : `X11; Linux ${arch === "arm64" ? "aarch64" : "x86_64"}`;
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36`;
}

export const DESKTOP_USER_AGENT = desktopUserAgent();

/** Desktop compatibility flags are last-wins; mobile presentation takes priority. */
export function webkitFromArgs(args) {
  return !args.includes("--mobile") && args.lastIndexOf("--webkit") >= args.lastIndexOf("--chromium");
}

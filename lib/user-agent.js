// Chrome 154 stable for desktop (2026-09-22). Keep CDP discovery, page JS, and
// HTTP requests on the same advertised version; casty reads /json/version.
export const CHROMIUM_VERSION = "154.0.8037.57";

export function desktopUserAgent(platform = process.platform, arch = process.arch) {
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : `X11; Linux ${arch === "arm64" ? "aarch64" : "x86_64"}`;
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36`;
}

export const DESKTOP_USER_AGENT = desktopUserAgent();

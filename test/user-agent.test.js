import { expect, test } from "bun:test";
import { CdpServer } from "../lib/cdp-server.js";
import { createBrowser } from "../lib/headless-shell.js";
import { MOBILE_USER_AGENT } from "../lib/renderer/flags.js";
import { CHROMIUM_VERSION, DESKTOP_USER_AGENT, desktopUserAgent } from "../lib/user-agent.js";

test("desktop user agent uses the same version on each platform", () => {
  for (const [platform, arch, system] of [
    ["linux", "arm64", "X11; Linux aarch64"],
    ["linux", "x64", "X11; Linux x86_64"],
    ["win32", "x64", "Windows NT 10.0; Win64; x64"],
    ["darwin", "arm64", "Macintosh; Intel Mac OS X 10_15_7"],
  ]) {
    expect(desktopUserAgent(platform, arch)).toBe(`Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36`);
  }
});

test("mobile uses current Chrome for Android rather than WebView", () => {
  expect(MOBILE_USER_AGENT).toBe(`Mozilla/5.0 (Linux; Android 16; ASUSAI2501C Build/BQ2A.250525.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Mobile Safari/537.36`);
});

test("CDP discovery, HTTP requests, and navigator report the same desktop user agent", async () => {
  let requestUserAgent;
  const site = Bun.serve({ port: 0, fetch(request) {
    requestUserAgent = request.headers.get("user-agent");
    return new Response("<!doctype html><title>UA test</title>", { headers: { "content-type": "text/html" } });
  } });
  const browser = await createBrowser({ spareRenderer: false });
  const cdp = CdpServer.create(browser.context).listen(0, "127.0.0.1");
  try {
    const version = await fetch(`http://127.0.0.1:${cdp.port}/json/version`).then((response) => response.json());
    expect(version.Browser).toBe(`Chrome/${CHROMIUM_VERSION}`);
    expect(version["User-Agent"]).toBe(DESKTOP_USER_AGENT);
    await browser.context.navigate(`http://127.0.0.1:${site.port}/`);
    expect(requestUserAgent).toBe(DESKTOP_USER_AGENT);
    expect(await browser.context.evaluate("navigator.userAgent")).toBe(DESKTOP_USER_AGENT);
  } finally {
    cdp.stop(true);
    browser.close();
    site.stop(true);
  }
});

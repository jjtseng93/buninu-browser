import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScreenshot, screenshotTargetUrl } from "../lib/screenshot-cli.js";
import { DESKTOP_USER_AGENT, WEBKIT_USER_AGENT } from "../lib/user-agent.js";

test("screenshot target treats Windows drive and UNC paths as files", () => {
  const options = {
    platform: "win32",
    resolvePath: (path) => path,
    fileURL: (path) => ({ href: `file:${path}` }),
  };
  for (const path of [String.raw`C:\Users\Ada\page.html`, "C:/Users/Ada/page.html", String.raw`\\server\share\page.html`, String.raw`pages\page.html`]) {
    expect(screenshotTargetUrl(path, options)).toBe(`file:${path}`);
  }
});

test("screenshot target preserves URLs and bare hostnames", () => {
  expect(screenshotTargetUrl("file:///C:/Users/Ada/page.html", { platform: "win32" })).toBe("file:///C:/Users/Ada/page.html");
  expect(screenshotTargetUrl("https://example.com", { platform: "win32" })).toBe("https://example.com");
  expect(screenshotTargetUrl("example.com", { platform: "win32" })).toBe("https://example.com");
});

test("screenshot mode defaults to WebKit and accepts both explicit desktop profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buninu-profile-test-"));
  let userAgent;
  const server = Bun.serve({ port: 0, fetch(request) {
    userAgent = request.headers.get("user-agent");
    return new Response("<!doctype html><p>identity</p>", { headers: { "content-type": "text/html" } });
  } });
  try {
    for (const [flags, expected] of [[[], WEBKIT_USER_AGENT], [["--webkit"], WEBKIT_USER_AGENT], [["--chromium"], DESKTOP_USER_AGENT]]) {
      const filename = join(directory, "page.png");
      await runScreenshot([`--screenshot=${filename}`, "--window-size=64,64", ...flags, `http://127.0.0.1:${server.port}/`]);
      expect(userAgent).toBe(expected);
      expect((await Bun.file(filename).bytes()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

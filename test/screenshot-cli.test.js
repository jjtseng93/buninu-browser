import { expect, test } from "bun:test";
import { screenshotTargetUrl } from "../lib/screenshot-cli.js";

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

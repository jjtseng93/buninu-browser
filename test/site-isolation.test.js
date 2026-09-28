import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser } from "../lib/headless-shell.js";

let server;
let browser;
beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/bounce") {
        return new Response(null, { status: 302, headers: { location: `http://localhost:${server.port}/landed` } });
      }
      return new Response(`<title>${pathname.slice(1)}</title><p>${pathname}</p>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await createBrowser({ spareRenderer: true });
});
afterAll(() => {
  browser?.close();
  server?.stop(true);
});

const loopback = (path) => `http://127.0.0.1:${server.port}${path}`;
const local = (path) => `http://localhost:${server.port}${path}`;

test("keeps one renderer per origin and swaps on cross-origin navigation", async () => {
  const { context } = browser;
  await context.navigate(loopback("/one"));
  const first = browser.rendererPid;
  expect(await context.title()).toBe("one");

  await context.navigate(loopback("/two"));
  expect(browser.rendererPid).toBe(first);

  await context.navigate(local("/three"));
  const second = browser.rendererPid;
  expect(second).not.toBe(first);
  expect(await context.title()).toBe("three");
  // The old origin's process is gone.
  expect(() => process.kill(first, 0)).toThrow();

  // History back to the first origin gets a fresh process, not the old one.
  await context.goBack();
  expect(await context.title()).toBe("two");
  expect(browser.rendererPid).not.toBe(second);
  expect(browser.rendererPid).not.toBe(first);
}, 60_000);

test("picks the renderer by the final URL after redirects and replays the viewport", async () => {
  const { context } = browser;
  await context.navigate(loopback("/start"));
  await context.resize(320, 240, 1);
  const before = browser.rendererPid;
  await context.navigate(loopback("/bounce"));
  expect(browser.rendererPid).not.toBe(before);
  expect(await context.title()).toBe("landed");
  expect(await context.evaluate("innerWidth")).toBe(320);
}, 60_000);

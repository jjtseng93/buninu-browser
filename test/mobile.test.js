import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser } from "../lib/headless-shell.js";
import { MOBILE_USER_AGENT } from "../lib/renderer/flags.js";
import { mediaQueryMatches } from "../lib/style/computed-style.js";

let server;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => new Response(`<!doctype html><title>${request.headers.get("user-agent")}</title>
      <style>@media (hover: none) and (pointer: coarse) { body { background: rgb(0, 0, 255) } }</style>
      <p>ua</p>`, { headers: { "content-type": "text/html" } }),
  });
});
afterAll(() => server?.stop(true));

test("touch media features match only in mobile mode", () => {
  const desktop = { width: 400, height: 800 };
  const mobile = { ...desktop, mobile: true };
  for (const query of ["(hover: none)", "(pointer: coarse)", "(any-pointer: coarse)", "(hover: hover)", "(pointer: fine)"]) {
    expect(mediaQueryMatches(query, desktop)).toBeFalse();
  }
  expect(mediaQueryMatches("(hover: none)", mobile)).toBeTrue();
  expect(mediaQueryMatches("(pointer: coarse)", mobile)).toBeTrue();
  expect(mediaQueryMatches("(pointer)", mobile)).toBeTrue();
  expect(mediaQueryMatches("(hover: hover)", mobile)).toBeFalse();
  expect(mediaQueryMatches("(pointer: fine)", mobile)).toBeFalse();
});

async function pageState(options) {
  const browser = await createBrowser({ spareRenderer: false, ...options });
  try {
    await browser.context.setUserAgent("Desktop/1.0 (casty override)");
    await browser.context.navigate(`http://127.0.0.1:${server.port}/`);
    return {
      requestUserAgent: await browser.context.title(),
      navigatorUserAgent: await browser.context.evaluate("navigator.userAgent"),
      touch: await browser.context.evaluate("matchMedia('(pointer: coarse)').matches"),
      background: await browser.context.evaluate("getComputedStyle(document.body).backgroundColor"),
    };
  } finally {
    browser.close();
  }
}

test("--mobile sends the mobile user agent, ignores overrides and applies touch media rules", async () => {
  expect(await pageState({ mobile: true })).toEqual({
    requestUserAgent: MOBILE_USER_AGENT,
    navigatorUserAgent: MOBILE_USER_AGENT,
    touch: true,
    background: "rgba(0, 0, 255, 1)",
  });
}, 30_000);

test("without --mobile nothing changes: overrides apply and touch rules do not", async () => {
  const state = await pageState({});
  expect(state).toMatchObject({
    requestUserAgent: "Desktop/1.0 (casty override)",
    navigatorUserAgent: "Desktop/1.0 (casty override)",
    touch: false,
  });
  expect(state.background).not.toBe("rgba(0, 0, 255, 1)");
}, 30_000);

async function viewportState(options) {
  const browser = await createBrowser({ spareRenderer: false, ...options });
  try {
    await browser.context.resize(824, 600, 1);
    await browser.context.navigate(`http://127.0.0.1:${server.port}/`);
    const png = Buffer.from(await browser.context.screenshot(), "base64");
    return {
      innerWidth: await browser.context.evaluate("innerWidth"),
      scale: await browser.context.evaluate("visualViewport.scale"),
      devicePixelRatio: await browser.context.evaluate("devicePixelRatio"),
      frameWidth: png.readUInt32BE(16),
    };
  } finally {
    browser.close();
  }
}

test("--mobile lays a wide viewport out at phone width and scales it up to the same frame size", async () => {
  expect(await viewportState({ mobile: true })).toEqual({ innerWidth: 412, scale: 2, devicePixelRatio: 2, frameWidth: 824 });
  expect(await viewportState({})).toEqual({ innerWidth: 824, scale: 1, devicePixelRatio: 1, frameWidth: 824 });
}, 60_000);

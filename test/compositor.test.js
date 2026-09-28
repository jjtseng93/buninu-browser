import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser } from "../lib/headless-shell.js";
import { cropViewport, encodeImage, rgbaBitmap } from "../lib/paint/frame.js";
import { RendererHost } from "../lib/renderer/host.js";

const tallPage = `<!doctype html><title>tall</title><body style="margin:0">${
  Array.from({ length: 80 }, (_, index) => `<p style="margin:0;height:40px">line ${index}</p>`).join("")
}</body>`;

test("frames: viewport crops fill uncovered areas, and Bun.Image encodes the BMP wrapper exactly", async () => {
  // A 2x2 red tile at page y=10; the 2x4 viewport at y=9 sees background, red, red, background.
  const red = [255, 0, 0, 255];
  const tile = {
    pixels: new Uint8Array([...red, ...red, ...red, ...red]), pixelWidth: 2, pixelHeight: 2,
    x: 0, y: 10, width: 2, height: 2, scale: 1, background: [0, 0, 255, 255],
  };
  const { pixels, width, height } = cropViewport(tile, 0, 9, 2, 4);
  expect([width, height]).toEqual([2, 4]);
  const rows = Array.from({ length: 4 }, (_, row) => [...pixels.subarray(row * 8, row * 8 + 4)]);
  expect(rows).toEqual([[0, 0, 255, 255], red, red, [0, 0, 255, 255]]);

  expect(rgbaBitmap(pixels, width, height).byteLength).toBe(14 + 108 + pixels.byteLength);
  const png = await encodeImage(pixels, width, height);
  expect(await new Bun.Image(png).metadata()).toEqual({ width: 2, height: 4, format: "png" });
  const jpeg = await encodeImage(pixels, width, height, { format: "jpeg", quality: 90 });
  expect((await new Bun.Image(jpeg).metadata()).format).toBe("jpeg");
});

test("the compositor answers screenshots and scrolling while the main thread is busy", async () => {
  const host = new RendererHost({ timeout: 20_000 });
  try {
    await host.start();
    await host.call("resize", 400, 300, 1);
    await host.call("setUserAgent", "test");
    await host.call("loadDocument", { url: "https://page.test/", source: tallPage, contentType: "text/html" });
    await host.call("whenLoaded");
    const top = await host.composite("screenshot");
    expect(top.length).toBeGreaterThan(0);

    // Block the renderer's main thread for 2.5 s.
    const busy = host.call("evaluate", "(() => { const end = Date.now() + 2500; while (Date.now() < end); return 'done'; })()");
    await Bun.sleep(300);
    const started = performance.now();
    expect(await host.composite("scroll", 0, 120)).toEqual({ x: 0, y: 120 });
    const scrolled = await host.composite("screenshot");
    expect(performance.now() - started).toBeLessThan(1500);
    expect(scrolled).not.toBe(top);
    expect(await busy).toBe("done");

    // The main thread follows the compositor's scroll position once it is free.
    expect(await host.call("scrollOffset")).toEqual({ x: 0, y: 120 });
    // Its own screenshot is cut from the same tile.
    expect(await host.call("screenshot")).toBe(await host.composite("screenshot"));

    // Scrolling done by the main thread (a key press) moves the compositor too.
    await host.call("press", "End");
    const end = await host.composite("scrollOffset");
    expect(end.y).toBe(80 * 40 - 300);
  } finally {
    host.close();
  }
}, 30_000);

let server;
let releaseStyles;
let releaseScript;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/slow.js") {
        await new Promise((resolve) => (releaseScript = resolve));
        return new Response("document.title = 'slow script ran';", { headers: { "content-type": "text/javascript" } });
      }
      if (pathname === "/busy") {
        // A long page whose scripts change the DOM while a slow script keeps it loading.
        return new Response(`<!doctype html><title>busy</title><body style="margin:0">${
          Array.from({ length: 200 }, (_, index) => `<p style="margin:0;height:40px">row ${index}</p>`).join("")
        }<script>document.body.dataset.touched = "yes";</script><script src="/slow.js"></script></body>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/slow.css") {
        // Held until the test has looked at the preview.
        await new Promise((resolve) => (releaseStyles = resolve));
        return new Response("body { background: rgb(0, 0, 255); } p { color: white; }", {
          headers: { "content-type": "text/css" },
        });
      }
      return new Response(`<!doctype html><title>staged</title>
        <link rel="stylesheet" href="/slow.css"><style>p { margin: 0 }</style>
        <p>hello</p><script>document.title = "scripted";</script>`, { headers: { "content-type": "text/html" } });
    },
  });
});
afterAll(() => server?.stop(true));

test("a preview is shown while stylesheets load, then the styled page, then scripts and load", async () => {
  const browser = await createBrowser({ spareRenderer: false });
  const { context } = browser;
  const events = [];
  context.onLifecycle((name) => events.push(name));
  let frames = 0;
  context.onFrame(() => frames++);
  try {
    await context.resize(320, 200, 1);
    await context.navigate(`http://127.0.0.1:${server.port}/`);
    // navigate returned at the first paint: the stylesheet is still pending.
    expect(releaseStyles).toBeFunction();
    expect(events).toEqual([]);
    expect(context.lifecycleState()).toEqual([]);
    expect(await context.evaluate("document.title")).toBe("staged");
    expect(await context.evaluate("getComputedStyle(document.body).backgroundColor")).not.toBe("rgba(0, 0, 255, 1)");
    const preview = await context.screenshot();

    const framesBefore = frames;
    releaseStyles();
    const deadline = Date.now() + 10_000;
    while (!events.includes("load") && Date.now() < deadline) await Bun.sleep(50);
    expect(events).toEqual(["DOMContentLoaded", "load"]);
    expect(context.lifecycleState()).toEqual(["DOMContentLoaded", "load"]);
    expect(frames).toBeGreaterThan(framesBefore);
    expect(await context.evaluate("getComputedStyle(document.body).backgroundColor")).toBe("rgba(0, 0, 255, 1)");
    expect(await context.evaluate("document.title")).toBe("scripted");
    expect(await context.screenshot()).not.toBe(preview);
  } finally {
    releaseStyles?.();
    browser.close();
  }
}, 30_000);

test("scrolling past the painted area repaints there even while scripts keep the page loading", async () => {
  const browser = await createBrowser({ spareRenderer: false });
  const { context } = browser;
  try {
    await context.resize(400, 300, 1);
    const blank = await context.screenshot();
    await context.navigate(`http://127.0.0.1:${server.port}/busy`);
    expect(releaseScript).toBeFunction();
    expect(context.lifecycleState()).not.toContain("load");
    // Far below the first tile: the compositor shows background until the main thread paints there.
    const { y } = await context.scroll(0, 6000);
    expect(y).toBe(6000);
    await Bun.sleep(1500);
    const shot = await context.screenshot();
    expect(shot).not.toBe(blank);
    expect(shot.length).toBeGreaterThan(blank.length * 2);
    expect(context.lifecycleState()).not.toContain("load");
  } finally {
    releaseScript?.();
    browser.close();
  }
}, 30_000);

import { expect, test } from "bun:test";

async function readDevToolsUrl(stream, timeout = 15_000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timer;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`Browser exited before announcing CDP:\n${output}`);
          output += decoder.decode(value, { stream: true });
          const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) return match[1];
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP:\n${output}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

test("top-level shell exposes the parsed document through Bun.WebView", async () => {
  const pixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gkcDhU6l/MKvgAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0yOFQxNDoyMTo1OCswMDowMJYWtzsAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMjhUMTQ6MjE6NTgrMDA6MDDnSw+HAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTI4VDE0OjIxOjU4KzAwOjAwsF4uWAAAAABJRU5ErkJggg==",
    "base64",
  );
  const fixture = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/destination") {
        return new Response(`<!doctype html><title>Destination</title><h1>arrived</h1>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/site.css") {
        return new Response(`:root{--bg:#0d1117;--text:#e6edf3}html,body{background:var(--bg)}body{color:var(--text)}`, {
          headers: { "Content-Type": "text/css" },
        });
      }
      if (pathname === "/pixel.png") {
        return new Response(pixelPng, { headers: { "Content-Type": "image/png" } });
      }
      if (pathname === "/image" || pathname === "/broken-image") {
        const src = pathname === "/image" ? "/pixel.png" : "/missing.png";
        return new Response(`<!doctype html><style>body{background:#222}</style><body><img src="${src}" width="80" height="40"></body>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/plain" || pathname === "/styled") {
        const link = pathname === "/styled" ? `<link rel="stylesheet" href="/site.css">` : "";
        return new Response(`<!doctype html><head>${link}</head><body><p>same pixels</p></body>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`<!doctype html>
        <title>Formal parser &amp; CDP</title>
        <body data-ready="yes"><a href="/destination">destination</a><br>第一行 😀<br>second &copy;
          <script>document.title = "script ran"</script>
          <pre>${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}</pre>
          <h2 id="target">fragment target</h2>
        </body>`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  const browser = Bun.spawn({
    cmd: [process.execPath, "buninu-browser.js", "--remote-debugging-port=0"],
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  let view;
  try {
    const browserWebSocketUrl = await readDevToolsUrl(browser.stderr);
    view = new Bun.WebView({
      backend: { type: "chrome", url: browserWebSocketUrl },
      width: 480,
      height: 240,
    });
    await view.resize(480, 240);
    await view.navigate(`http://127.0.0.1:${fixture.port}/`);

    // The inline script runs (in the page sandbox) and renames the document.
    expect(view.title).toBe("script ran");
    expect(await view.evaluate("document.title")).toBe("script ran");
    expect(await view.evaluate("document.body.innerText")).toContain("第一行 😀\nsecond ©");
    const html = await view.evaluate("document.documentElement.outerHTML");
    expect(html).toContain('data-ready="yes"');
    expect(html).toContain("<script>document.title = \"script ran\"</script>");

    const screenshot = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(await new Bun.Image(screenshot).metadata()).toEqual({
      width: 480,
      height: 240,
      format: "png",
    });
    await view.cdp("Emulation.setDeviceMetricsOverride", {
      width: 480,
      height: 240,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const hidpiScreenshot = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(await new Bun.Image(hidpiScreenshot).metadata()).toEqual({
      width: 960,
      height: 480,
      format: "png",
    });
    await view.cdp("Emulation.setDeviceMetricsOverride", {
      width: 480,
      height: 240,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await view.navigate(`http://127.0.0.1:${fixture.port}/plain`);
    const plain = await view.screenshot({ encoding: "buffer", format: "png" });
    await view.navigate(`http://127.0.0.1:${fixture.port}/styled`);
    expect(await view.evaluate("document.documentElement.outerHTML")).toContain("site.css");
    const styled = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(Bun.hash(styled)).not.toBe(Bun.hash(plain));
    await view.navigate(`http://127.0.0.1:${fixture.port}/image`);
    const withImage = await view.screenshot({ encoding: "buffer", format: "png" });
    await view.navigate(`http://127.0.0.1:${fixture.port}/broken-image`);
    const withBrokenImage = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(Bun.hash(withImage)).not.toBe(Bun.hash(withBrokenImage));
    await view.navigate(`http://127.0.0.1:${fixture.port}/`);

    expect(await view.evaluate("scrollY")).toBe(0);
    await view.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 100,
      y: 100,
      deltaX: 0,
      deltaY: 100,
    });
    expect(await view.evaluate("scrollY")).toBe(100);
    const scrolled = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(Bun.hash(scrolled)).not.toBe(Bun.hash(screenshot));

    await view.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "End",
      code: "End",
    });
    const endOffset = await view.evaluate("scrollY");
    expect(endOffset).toBeGreaterThan(100);
    await view.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End" });

    await view.navigate(`http://127.0.0.1:${fixture.port}/again`);
    expect(await view.evaluate("scrollY")).toBe(0);
    await view.navigate(`http://127.0.0.1:${fixture.port}/again#target`);
    expect(view.url).toBe(`http://127.0.0.1:${fixture.port}/again#target`);
    expect(await view.evaluate("scrollY")).toBeGreaterThan(0);
    await view.navigate(`http://127.0.0.1:${fixture.port}/again`);
    expect(await view.evaluate("scrollY")).toBe(0);

    const hintResult = await view.cdp("Runtime.evaluate", {
      expression: `(() => {
        const CLICKABLE = 'a';
        return 'data-casty-hint-id';
      })()`,
      returnByValue: true,
    });
    const hints = JSON.parse(hintResult.result.value);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ id: "0", label: "a", type: "click" });

    await view.cdp("Runtime.evaluate", {
      expression: `(() => { const el = document.getElementById('__casty_hints'); if (el) el.remove(); })()`,
    });
    const resolvedHint = await view.cdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-casty-hint-id="0"]');
        if (!el) throw new Error('hint target disappeared');
      })()`,
      returnByValue: true,
    });
    const click = {
      x: resolvedHint.result.value.x,
      y: resolvedHint.result.value.y,
      button: "left",
      clickCount: 1,
    };
    const beforeMarker = await view.screenshot({ encoding: "buffer", format: "png" });
    await view.cdp("Runtime.evaluate", {
      expression: `(async () => {
        const marker = document.createElement('div');
        marker.id = '__casty_click_marker';
        marker.style.cssText = [
          'position:fixed',
          'left:' + ${click.x} + 'px',
          'top:' + ${click.y} + 'px',
          'width:14px',
          'height:14px',
          'margin-left:-7px',
          'margin-top:-7px',
          'box-sizing:border-box',
          'border:2px solid white',
          'border-radius:50%',
          'background:#f00',
          'box-shadow:0 0 0 2px rgba(255,0,0,.45)',
          'pointer-events:none',
          'z-index:2147483647',
        ].join(';');
        document.documentElement.appendChild(marker);
        setTimeout(() => marker.remove(), 800);
        await new Promise(resolve => requestAnimationFrame(resolve));
      })()`,
    });
    const markerState = await view.cdp("Runtime.evaluate", {
      expression: `(() => { const marker = document.getElementById('__casty_click_marker'); return marker ? marker.style.cssText : null })()`,
      returnByValue: true,
    });
    expect(markerState.result.value).toContain("background");
    const markerLayout = await view.cdp("Runtime.evaluate", {
      expression: `(() => { const e = document.getElementById('__casty_click_marker'); const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return { position:s.position, display:s.display, background:s.backgroundColor, x:r.x, y:r.y, width:r.width, height:r.height } })()`,
      returnByValue: true,
    });
    expect(markerLayout.result.value).toEqual({
      position: "fixed",
      display: "block",
      background: "rgba(255, 0, 0, 1)",
      x: click.x - 7,
      y: click.y - 7,
      width: 14,
      height: 14,
    });
    const withMarker = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(Bun.hash(withMarker)).not.toBe(Bun.hash(beforeMarker));
    await view.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...click, buttons: 1 });
    await view.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...click, buttons: 0 });
    // The URL changes when the navigation commits; the title follows once the
    // page reports load, as in Chromium.
    for (let attempt = 0; attempt < 200 && !(view.url.endsWith("/destination") && view.title === "Destination"); attempt++) {
      await Bun.sleep(10);
    }
    expect(view.url).toBe(`http://127.0.0.1:${fixture.port}/destination`);
    expect(view.title).toBe("Destination");

    const history = await view.cdp("Page.getNavigationHistory");
    const previous = history.entries[history.currentIndex - 1];
    await view.cdp("Page.navigateToHistoryEntry", { entryId: previous.id });
    for (let attempt = 0; attempt < 20 &&
      (!view.url.endsWith("/again") || view.title !== "script ran"); attempt++) {
      await Bun.sleep(10);
    }
    expect(view.url).toBe(`http://127.0.0.1:${fixture.port}/again`);
    expect(view.title).toBe("script ran");

    await view.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 100,
    });
    expect(await view.evaluate("scrollY")).toBe(100);
    await view.navigate(`http://127.0.0.1:${fixture.port}/destination`);
    const secondHistory = await view.cdp("Page.getNavigationHistory");
    await view.cdp("Page.navigateToHistoryEntry", {
      entryId: secondHistory.entries[secondHistory.currentIndex - 1].id,
    });
    expect(await view.evaluate("scrollY")).toBe(100);

  } finally {
    view?.close();
    Bun.WebView.closeAll();
    browser.kill();
    fixture.stop(true);
    await browser.exited;
  }
}, 30_000);

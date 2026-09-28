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
  const fixture = Bun.serve({
    port: 0,
    fetch() {
      return new Response(`<!doctype html>
        <title>Formal parser &amp; CDP</title>
        <body data-ready="yes">第一行 😀<br>second &copy;
          <script>document.title = "script ran"</script>
          <pre>${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}</pre>
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

    expect(view.title).toBe("Formal parser & CDP");
    expect(await view.evaluate("document.title")).toBe("Formal parser & CDP");
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
  } finally {
    view?.close();
    Bun.WebView.closeAll();
    browser.kill();
    fixture.stop(true);
    await browser.exited;
  }
}, 30_000);

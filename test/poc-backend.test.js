import { expect, test } from "bun:test";

const TEST_WIDTH = 640;
const TEST_HEIGHT = 360;
const RESIZED_WIDTH = 480;
const RESIZED_HEIGHT = 240;

function fixtureHtml(includeScript = true) {
  const script = includeScript
    ? "<script>document.body.textContent = 'SCRIPT MUST NOT RUN'</script>"
    : "";
  return `<!doctype html>
    <html>
      <head><title>POC integration</title></head>
      <body>
        Buninu Browser 的第一個整合測試 😀 🎉 ✅ 🏳️‍🌈 🇹🇼<br>
        This line is deliberately longer than forty columns so wrapping is exercised.
        <strong>Tags are discarded but their text remains.</strong>
        ${script}
      </body>
    </html>`;
}

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
          if (done) throw new Error(`POC exited before announcing CDP:\n${output}`);
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

async function pngMetadata(bytes) {
  return new Bun.Image(bytes).metadata();
}

test("POC satisfies the Chromium launch and Bun.WebView CDP contract", async () => {
  const fixture = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      return new Response(fixtureHtml(url.pathname !== "/without-script"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  const path = `${import.meta.dir}:${Bun.env.PATH ?? ""}`;
  const executable = Bun.which("chromium-headless-shell", { PATH: path });
  expect(executable).toBe(`${import.meta.dir}/chromium-headless-shell`);

  const browser = Bun.spawn({
    cmd: [
      executable,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--headless",
    ],
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  let view;
  try {
    const browserWebSocketUrl = await readDevToolsUrl(browser.stderr);
    const port = new URL(browserWebSocketUrl).port;

    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
    expect(version["Protocol-Version"]).toBe("1.3");
    expect(version.webSocketDebuggerUrl).toBe(browserWebSocketUrl);

    view = new Bun.WebView({
      backend: { type: "chrome", url: browserWebSocketUrl },
      width: TEST_WIDTH,
      height: TEST_HEIGHT,
    });

    const screencastFrame = new Promise((resolve) => {
      view.addEventListener("Page.screencastFrame", (event) => resolve(event.data), { once: true });
    });

    await view.resize(TEST_WIDTH, TEST_HEIGHT);
    await view.navigate(`http://127.0.0.1:${fixture.port}/with-script`);
    expect(view.url).toBe(`http://127.0.0.1:${fixture.port}/with-script`);
    expect(view.title).toBe("POC integration");
    expect(await view.evaluate("document.title")).toBe("POC integration");

    await view.cdp("Page.startScreencast", {
      format: "png",
      maxWidth: TEST_WIDTH,
      maxHeight: TEST_HEIGHT,
      everyNthFrame: 1,
    });
    const frame = await screencastFrame;
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(100);
    await view.cdp("Page.screencastFrameAck", { sessionId: frame.sessionId });
    await view.cdp("Page.stopScreencast");

    const first = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(await pngMetadata(first)).toEqual({ width: TEST_WIDTH, height: TEST_HEIGHT, format: "png" });
    expect(first.length).toBeGreaterThan(1_000);

    await view.navigate(`http://127.0.0.1:${fixture.port}/without-script`);
    const withoutScript = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(Bun.hash(withoutScript)).toBe(Bun.hash(first));

    await view.resize(RESIZED_WIDTH, RESIZED_HEIGHT);
    const resized = await view.screenshot({ encoding: "buffer", format: "png" });
    expect(await pngMetadata(resized)).toEqual({
      width: RESIZED_WIDTH,
      height: RESIZED_HEIGHT,
      format: "png",
    });
    expect(Bun.hash(resized)).not.toBe(Bun.hash(first));

    const capture = await view.cdp("Page.captureScreenshot", { format: "png" });
    expect(await pngMetadata(Buffer.from(capture.data, "base64"))).toEqual({
      width: RESIZED_WIDTH,
      height: RESIZED_HEIGHT,
      format: "png",
    });
  } finally {
    view?.close();
    Bun.WebView.closeAll();
    browser.kill();
    fixture.stop(true);
    await browser.exited;
  }
}, 30_000);

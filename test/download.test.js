import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser } from "../lib/headless-shell.js";
import { isAttachment, suggestedFilename } from "../lib/download.js";
import { downloadsDirectory } from "../lib/download-directory.js";

// Big5 for 中文, which a UTF-8 decode would mangle: the download must be the bytes as sent.
const BIG5 = new Uint8Array([0x3c, 0x70, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5, 0x3c, 0x2f, 0x70, 0x3e]);
let server;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/page") return new Response(BIG5, { headers: { "content-type": "text/html; charset=big5" } });
      if (path === "/links") return new Response('<a id="explicit" href="/plain" download="chosen.txt">explicit</a>'
        + '<a id="attachment" href="/attachment">attachment</a>'
        + '<a id="data" href="data:text/plain,hello%20data" download="data.txt">data</a>'
        + '<a id="blob" download="blob.txt">blob</a>'
        + '<script>document.getElementById("blob").href = URL.createObjectURL(new Blob(["blob bytes"]));</script>',
      { headers: { "content-type": "text/html" } });
      if (path === "/plain") return new Response("original bytes", { headers: { "content-type": "text/plain" } });
      if (path === "/attachment") return new Response("photo bytes", { headers: {
        "content-type": "image/jpeg", "content-disposition": 'attachment; filename="photo.jpg"',
      } });
      if (path === "/preview.json") return new Response('{"a":1}\n', { headers: { "content-type": "application/json" } });
      return Response.redirect("/page");
    },
  });
});

test("download names from headers and attributes are safe", () => {
  expect(isAttachment('attachment; filename="x.jpg"')).toBeTrue();
  expect(isAttachment('inline; filename="x.jpg"')).toBeFalse();
  expect(suggestedFilename("https://x.test/a", "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.jpg")).toBe("中文.jpg");
  expect(suggestedFilename("https://x.test/a", "", "../escape.txt")).toBe("escape.txt");
});

test("download directory follows macOS defaults and relocated Windows folders", () => {
  expect(downloadsDirectory({ platform: "darwin", home: "/Users/Ada" })).toBe("/Users/Ada/Downloads");
  expect(downloadsDirectory({ platform: "win32", home: "C:\\Users\\Ada", queryWindows: () => "D:\\資料\\下載" }))
    .toBe("D:\\資料\\下載");
  expect(downloadsDirectory({ platform: "win32", home: "C:\\Users\\Ada", queryWindows: () => null }))
    .toBe("C:\\Users\\Ada\\Downloads");
});

test("clicked downloads save files and leave the current page in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buninu-download-"));
  const browser = await createBrowser({ spareRenderer: false });
  const events = [];
  browser.context.setDownloadBehavior({ behavior: "allow", downloadPath: dir, eventsEnabled: true });
  browser.context.onDownload((event, params) => events.push({ event, ...params }));
  const origin = `http://127.0.0.1:${server.port}`;
  const click = async (selector) => {
    const bounds = await browser.context.evaluate(`JSON.stringify(document.querySelector('${selector}').getBoundingClientRect())`);
    const rect = JSON.parse(bounds);
    await browser.context.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  try {
    await browser.context.navigate(`${origin}/links`);
    await click("#explicit");
    expect(readFileSync(join(dir, "chosen.txt"), "utf8")).toBe("original bytes");
    expect(browser.context.resourceContent()?.url).toBe(`${origin}/links`);
    await click("#explicit");
    expect(readFileSync(join(dir, "chosen (2).txt"), "utf8")).toBe("original bytes");
    await browser.context.evaluate("document.getElementById('explicit').click()");
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if (readFileSync(join(dir, "chosen (3).txt"), "utf8") === "original bytes") break; } catch {}
      await Bun.sleep(20);
    }
    expect(readFileSync(join(dir, "chosen (3).txt"), "utf8")).toBe("original bytes");
    await click("#attachment");
    expect(readFileSync(join(dir, "photo.jpg"), "utf8")).toBe("photo bytes");
    expect(browser.context.resourceContent()?.url).toBe(`${origin}/links`);
    await click("#data");
    expect(readFileSync(join(dir, "data.txt"), "utf8")).toBe("hello data");
    await browser.context.evaluate("document.getElementById('blob').click()");
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if (readFileSync(join(dir, "blob.txt"), "utf8") === "blob bytes") break; } catch {}
      await Bun.sleep(20);
    }
    expect(readFileSync(join(dir, "blob.txt"), "utf8")).toBe("blob bytes");
    await browser.context.navigate(`${origin}/preview.json`);
    const positions = JSON.parse(await browser.context.evaluate(`JSON.stringify({
      pretty: document.getElementById('pretty-print').getBoundingClientRect().right,
      download: document.querySelector('.download').getBoundingClientRect().left,
      right: document.querySelector('.download').getBoundingClientRect().right
    })`));
    expect(positions.download).toBeGreaterThan(positions.pretty);
    expect(positions.right).toBeGreaterThan(700);
    await click(".download");
    expect(readFileSync(join(dir, "preview.json"), "utf8")).toBe('{"a":1}\n');
    expect(browser.context.resourceContent()?.url).toBe(`${origin}/preview.json`);
    expect(events.filter((item) => item.event === "willBegin")).toHaveLength(7);
    expect(events.filter((item) => item.event === "progress" && item.state === "completed")).toHaveLength(7);
  } finally {
    browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
afterAll(() => server?.stop(true));

test("the current document's raw bytes stay available for Page.getResourceContent", async () => {
  const browser = await createBrowser({ spareRenderer: false });
  try {
    const { context } = browser;
    expect(context.resourceContent()).toBeNull();
    await context.navigate(`http://127.0.0.1:${server.port}/start`);
    const page = `http://127.0.0.1:${server.port}/page`;
    const resource = context.resourceContent(page);
    expect(resource).toMatchObject({ url: page, contentType: "text/html; charset=big5" });
    expect([...resource.body]).toEqual([...BIG5]);
    // The URL that was asked for, a fragment of it, and no URL at all mean the current document.
    await context.navigate(`${page}#part`);
    expect(context.resourceContent(`${page}#other`)?.body).toBe(resource.body);
    expect(context.resourceContent()?.body).toBe(resource.body);
    expect(context.resourceContent(`http://127.0.0.1:${server.port}/elsewhere`)).toBeNull();
    await context.navigate("about:blank");
    expect(context.resourceContent()).toBeNull();
  } finally {
    browser.close();
  }
}, 30_000);

test("CDP Page.getResourceContent returns the bytes base64-encoded", async () => {
  const { CdpServer } = await import("../lib/cdp-server.js");
  const body = new Uint8Array([0, 1, 2, 255]);
  const cdp = new CdpServer({ resourceContent: (url) => url === "https://x.test/f" ? { body, contentType: "image/png" } : null }).listen(0, "127.0.0.1");
  try {
    const target = await (await fetch(`http://127.0.0.1:${cdp.port}/json/new?https://x.test/f`, { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const call = (id, method, params) => new Promise((resolve) => {
      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id === id) resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    // The frame reports the document's own type, not the HTML shown for it.
    expect((await call(0, "Page.getFrameTree", {})).result.frameTree.frame).toMatchObject({ url: "https://x.test/f", mimeType: "image/png" });
    expect((await call(1, "Page.getResourceContent", { frameId: target.id, url: "https://x.test/f" })).result)
      .toEqual({ content: "AAEC/w==", base64Encoded: true });
    expect((await call(2, "Page.getResourceContent", { frameId: target.id, url: "https://x.test/g" })).error?.message)
      .toBe("No resource with given URL found");
    socket.close();
  } finally {
    cdp.stop(true);
  }
});

test("CDP downloads the committed document after a navigation outside CDP", async () => {
  const { CdpServer } = await import("../lib/cdp-server.js");
  const browser = await createBrowser({ spareRenderer: false });
  const cdp = CdpServer.create(browser.context).listen(0, "127.0.0.1");
  let socket;
  try {
    const target = await (await fetch(`http://127.0.0.1:${cdp.port}/json/new?about:blank`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    let nextId = 0;
    const call = (method, params = {}) => new Promise(resolve => {
      const id = ++nextId;
      const listener = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        socket.removeEventListener("message", listener);
        resolve(message);
      };
      socket.addEventListener("message", listener);
      socket.send(JSON.stringify({ id, method, params }));
    });
    await browser.context.navigate(`http://127.0.0.1:${server.port}/start`);
    const { result: { frameTree } } = await call("Page.getFrameTree");
    expect(frameTree.frame.url).toBe(`http://127.0.0.1:${server.port}/page`);
    expect(frameTree.frame.mimeType).toBe("text/html");
    const result = await call("Page.getResourceContent", { frameId: frameTree.frame.id, url: frameTree.frame.url });
    expect(result.error).toBeUndefined();
    expect(Buffer.from(result.result.content, "base64")).toEqual(Buffer.from(BIG5));
  } finally {
    socket?.close();
    cdp.stop(true);
    browser.close();
  }
});

test("CDP download behavior controls the directory and emits completion events", async () => {
  const { CdpServer } = await import("../lib/cdp-server.js");
  const dir = mkdtempSync(join(tmpdir(), "buninu-cdp-download-"));
  const browser = await createBrowser({ spareRenderer: false });
  const cdp = CdpServer.create(browser.context).listen(0, "127.0.0.1");
  const socket = new WebSocket(`ws://127.0.0.1:${cdp.port}/devtools/browser/cdp-server`);
  const events = [];
  try {
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method?.startsWith("Browser.download")) events.push(message);
    });
    const configured = new Promise((resolve) => socket.addEventListener("message", ({ data }) => {
      if (JSON.parse(data).id === 1) resolve();
    }));
    socket.send(JSON.stringify({ id: 1, method: "Browser.setDownloadBehavior", params: {
      behavior: "allowAndName", downloadPath: dir, eventsEnabled: true,
    } }));
    await configured;
    await browser.context.navigate(`http://127.0.0.1:${server.port}/links`);
    const rect = JSON.parse(await browser.context.evaluate("JSON.stringify(document.getElementById('attachment').getBoundingClientRect())"));
    await browser.context.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await Bun.sleep(30);
    expect(readFileSync(join(dir, events[0].params.guid), "utf8")).toBe("photo bytes");
    expect(events.map((item) => item.method)).toEqual([
      "Browser.downloadWillBegin", "Browser.downloadProgress", "Browser.downloadProgress",
    ]);
    expect(events[0].params.suggestedFilename).toBe("photo.jpg");
    expect(events[1].params.state).toBe("inProgress");
    expect(events[2].params.state).toBe("completed");
    expect(events[2].params.filePath).toBe(join(dir, events[0].params.guid));
  } finally {
    socket.close();
    cdp.stop(true);
    browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

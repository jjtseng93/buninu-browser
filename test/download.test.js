import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser } from "../lib/headless-shell.js";

// Big5 for 中文, which a UTF-8 decode would mangle: the download must be the bytes as sent.
const BIG5 = new Uint8Array([0x3c, 0x70, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5, 0x3c, 0x2f, 0x70, 0x3e]);
let server;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => new URL(request.url).pathname === "/page"
      ? new Response(BIG5, { headers: { "content-type": "text/html; charset=big5" } })
      : Response.redirect("/page"),
  });
});
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
  const cdp = new CdpServer({ resourceContent: (url) => url === "https://x.test/f" ? { body } : null }).listen(0, "127.0.0.1");
  try {
    const target = await (await fetch(`http://127.0.0.1:${cdp.port}/json/new?about:blank`, { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const call = (id, method, params) => new Promise((resolve) => {
      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id === id) resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    expect((await call(1, "Page.getResourceContent", { frameId: target.id, url: "https://x.test/f" })).result)
      .toEqual({ content: "AAEC/w==", base64Encoded: true });
    expect((await call(2, "Page.getResourceContent", { frameId: target.id, url: "https://x.test/g" })).error?.message)
      .toBe("No resource with given URL found");
    socket.close();
  } finally {
    cdp.stop(true);
  }
});

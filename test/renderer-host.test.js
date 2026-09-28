import { afterEach, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

const entry = new URL("./fixtures/fake-renderer.js", import.meta.url).pathname;
const hosts = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});
function host(options = {}) {
  const created = new RendererHost({ entry, timeout: 1500, ...options });
  hosts.push(created);
  return created;
}

test("runs calls in a separate process with an empty environment", async () => {
  const renderer = host();
  await renderer.start();
  const result = await renderer.call("echo", { hello: new Uint8Array([1, 2]) });
  expect(result.pid).not.toBe(process.pid);
  expect(result.pid).toBe(renderer.pid);
  expect(result.argument.hello).toEqual(new Uint8Array([1, 2]));
});

test("kills a renderer that misses its deadline and restarts it on the next call", async () => {
  const restarts = [];
  const renderer = host({
    onRestart: async (call) => {
      restarts.push((await call("echo", "restored")).argument);
    },
  });
  await renderer.start();
  const firstPid = renderer.pid;
  const started = performance.now();
  await expect(renderer.call("hang")).rejects.toThrow("timed out");
  expect(performance.now() - started).toBeLessThan(5000);
  const after = await renderer.call("echo", "next");
  expect(after.pid).not.toBe(firstPid);
  expect(after.argument).toBe("next");
  expect(restarts).toEqual(["restored"]);
});

test("surfaces renderer errors without their stack", async () => {
  const renderer = host();
  await expect(renderer.call("fail")).rejects.toThrow("renderer: Error: page crashed");
});

test("ignores forged results and unknown messages from the renderer", async () => {
  const renderer = host();
  expect(await renderer.call("forge")).toBe("real");
});

test("fetches only http(s)/data resources on the renderer's behalf", async () => {
  const requested = [];
  const renderer = host({
    fetch: async (url) => {
      requested.push(url.href);
      return new Response("body!", { status: 200, headers: { "content-type": "text/css" } });
    },
  });
  expect(await renderer.call("fetch", { url: "https://example.test/a.css", kind: "stylesheet" }))
    .toEqual({ status: 200, bytes: 5 });
  expect(await renderer.call("fetch", { url: "file:///etc/passwd", kind: "stylesheet" }))
    .toEqual({ error: "blocked stylesheet request for file:" });
  expect(await renderer.call("fetch", { url: "https://example.test/x", kind: "script-with-cookies" }))
    .toEqual({ error: "blocked script-with-cookies request for https:" });
  expect(requested).toEqual(["https://example.test/a.css"]);
});

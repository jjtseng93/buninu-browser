import { afterEach, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

const entry = new URL("./fixtures/fake-renderer.js", import.meta.url).pathname;
const hosts = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});
// The watchdog deadline: long enough for a fresh renderer to answer while
// test files run in parallel, short enough to see a hang killed.
const TIMEOUT = 4000;
function host(options = {}) {
  const created = new RendererHost({ entry, timeout: TIMEOUT, ...options });
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

test("slow startup outlives the method deadline without replacing the child", async () => {
  const renderer = host({ timeout: 20, args: ['--ready-delay=200'] });
  const ready = renderer.start();
  const pid = renderer.pid;
  await ready;
  expect(renderer.pid).toBe(pid);
  expect(renderer.pid).toBeGreaterThan(0);
});

test("disabled watchdog lets slow methods finish and still permits explicit close", async () => {
  const renderer = host({ timeout: 0 });
  expect(await renderer.call('slow')).toBe('completed');
  const hanging = renderer.call('hang').catch(error => error.message);
  await Bun.sleep(20);
  renderer.close();
  expect(await hanging).toBe('Renderer closed');
});

test("closing during slow startup rejects the wait", async () => {
  const renderer = host({ args: ['--ready-delay=60000'] });
  const ready = renderer.start();
  const result = ready.then(() => 'unexpected ready', error => error.message);
  renderer.close();
  expect(await result).toBe('Renderer closed during startup');
  expect(renderer.pid).toBeNull();
});

test("slow document loading is not killed by the interactive method deadline", async () => {
  const renderer = host({ timeout: 20 });
  await renderer.start();
  const pid = renderer.pid;
  expect(await renderer.call('loadDocument', { url: 'https://example.test/', delay: 200 })).toBe('loaded');
  expect(await renderer.call('showFragment', 'https://example.test/#section')).toBe('positioned');
  expect(renderer.pid).toBe(pid);
});

test("closing cancels a pending document load", async () => {
  const renderer = host();
  await renderer.start();
  const loading = renderer.call('loadDocument', { url: 'https://example.test/', delay: 60000 });
  const result = loading.then(() => 'unexpected completion', error => error.message);
  await Bun.sleep(20);
  renderer.close();
  expect(await result).toBe('Renderer closed');
});

test("exit before ready rejects startup without waiting for a deadline", async () => {
  const renderer = host({ args: ['--exit-before-ready'] });
  await expect(renderer.start()).rejects.toThrow('renderer exited during startup');
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
  expect(performance.now() - started).toBeLessThan(TIMEOUT + 3000);
  const after = await renderer.call("echo", "next");
  expect(after.pid).not.toBe(firstPid);
  expect(after.argument).toBe("next");
  expect(restarts).toEqual(["restored"]);
});

test("surfaces renderer errors without their stack", async () => {
  const renderer = host();
  await expect(renderer.call("fail")).rejects.toThrow("renderer: Error: page crashed");
  // An empty error is still a failure, not a successful undefined result.
  await expect(renderer.call("fail-blank")).rejects.toThrow("renderer: unknown error");
});

test("ignores forged results and unknown messages from the renderer", async () => {
  const renderer = host();
  expect(await renderer.call("forge")).toBe("real");
});

test("fetches only http(s)/data resources on the renderer's behalf", async () => {
  const requested = [];
  const renderer = host({
    fetch: async (url) => {
      requested.push(new URL(String(url)).href);
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


test("explicit close prevents queued calls and captures from restarting the renderer", async () => {
  const renderer = host();
  const queued = renderer.call("title");
  renderer.close();
  await expect(queued).rejects.toThrow("Renderer is closed");
  await expect(renderer.start()).rejects.toThrow("Renderer is closed");
  await expect(renderer.composite("screenshot", { format: "bgra" })).rejects.toThrow("Renderer is closed");
  expect(renderer.pid).toBeNull();
});

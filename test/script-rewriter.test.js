import { expect, test } from "bun:test";
import { startScriptRewriter } from "../lib/renderer/script-rewriter.js";
import { prepareModuleOffThread, prepareModuleSource } from "../lib/renderer/module-preparation.js";
import { prepareClassicScript } from "../lib/renderer/prepared-script-cache.js";
import { transformModule } from "../lib/renderer/module-transform.js";
import { rewriteModuleSource } from "../lib/renderer/script-rewrite.js";

class FakeWorker extends EventTarget {
  messages = [];
  terminated = false;
  unreferenced = false;
  emit(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type), fields)); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  unref() { this.unreferenced = true; }
}

async function startedWorker() {
  const worker = new FakeWorker();
  const starting = startScriptRewriter({ createWorker: () => worker });
  worker.emit("message", { data: { type: "ready" } });
  return { worker, rewrite: await starting };
}

test("script worker startup errors and early closure allow synchronous fallback", async () => {
  expect(await startScriptRewriter({ createWorker() { throw new Error("Unavailable"); } })).toBeNull();
  for (const event of ["error", "close", "messageerror"]) {
    const worker = new FakeWorker();
    const starting = startScriptRewriter({ createWorker: () => worker });
    worker.emit(event, { message: "Failed startup" });
    expect(await starting).toBeNull();
    expect(worker.terminated).toBeTrue();
  }
});

test("script worker keeps per-request errors separate and forwards module realm mode", async () => {
  const { worker, rewrite } = await startedWorker();
  try {
    expect(worker.unreferenced).toBeTrue();
    const first = rewrite("bad source");
    const second = rewrite("export default 1", { type: "module", mode: "host" });
    const results = Promise.allSettled([first, second]);
    expect(worker.messages[0].options).toBeUndefined();
    expect(worker.messages[1].options).toEqual({ type: "module", mode: "host" });
    worker.emit("message", { data: { id: worker.messages[1].id, result: { code: "module", requests: [] } } });
    worker.emit("message", { data: { id: worker.messages[0].id, error: "Invalid source" } });
    const [failed, passed] = await results;
    expect(failed.status).toBe("rejected");
    expect(failed.reason.message).toBe("Invalid source");
    expect(passed).toEqual({ status: "fulfilled", value: { code: "module", requests: [] } });
    expect(worker.terminated).toBeFalse();
  } finally { rewrite.close(); }
});

test("fatal worker failures reject current and future work instead of hanging", async () => {
  for (const event of ["error", "close", "messageerror"]) {
    const { worker, rewrite } = await startedWorker();
    const results = Promise.allSettled([rewrite("first"), rewrite("second")]);
    worker.emit(event, { message: "Worker died" });
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    await expect(rewrite("later")).rejects.toThrow();
    expect(worker.messages).toHaveLength(2);
    expect(worker.terminated).toBeTrue();
  }
});

test("a failed postMessage leaves no pending requests or future dead-worker submissions", async () => {
  const { worker, rewrite } = await startedWorker();
  const first = rewrite("first");
  worker.postMessage = () => { throw new Error("Cannot send"); };
  const results = await Promise.allSettled([first, rewrite("second")]);
  expect(results.map(result => result.reason.message)).toEqual(["Cannot send", "Cannot send"]);
  await expect(rewrite("later")).rejects.toThrow("Cannot send");
  expect(worker.terminated).toBeTrue();
});

const moduleSource = `
  import { value } from './dependency.js';
  import config from './data.json' with { type: 'json' };
  export { count } from './live.js';
  export const origin = import.meta.url;
  export const constructor = (async function () {}).constructor;
  export const result = value + config.value + (await import('./late.js')).default;
`;

test("module preparation preserves SES rewrites and leaves host source unrestricted", async () => {
  const expectedHost = transformModule(moduleSource);
  const expectedSes = transformModule(rewriteModuleSource(moduleSource));
  expect(expectedSes.code).not.toBe(expectedHost.code);
  expect(expectedHost.requests).toEqual([
    { specifier: "./dependency.js", type: null },
    { specifier: "./data.json", type: "json" },
    { specifier: "./live.js", type: null },
  ]);
  expect(prepareModuleSource(moduleSource, "host")).toEqual(expectedHost);
  expect(prepareModuleSource(moduleSource, "ses")).toEqual(expectedSes);
  expect(await prepareModuleOffThread(moduleSource, "host", null)).toEqual(expectedHost);
});

test("module worker failures and malformed responses repeat preparation locally", async () => {
  const expected = prepareModuleSource(moduleSource, "ses");
  for (const rewrite of [
    () => { throw new Error("Failed to send"); },
    async () => { throw new Error("Worker failed"); },
    async () => ({ code: "classic result", parsed: true, strict: false }),
    async () => ({ code: "bad requests", requests: [null] }),
  ]) expect(await prepareModuleOffThread(moduleSource, "ses", rewrite)).toEqual(expected);
  // Transport errors must not replace a module's real parse error with Error.
  await expect(prepareModuleOffThread("export const = ;", "ses", async () => {
    throw new Error("SyntaxError from worker");
  })).rejects.toBeInstanceOf(SyntaxError);
});

test("real worker prepares classic and module sources without executing them", async () => {
  const rewrite = await startScriptRewriter();
  expect(rewrite).not.toBeNull();
  try {
    const source = "throw new Error('Source must not execute'); var result = 2;";
    expect(await rewrite(source)).toEqual(prepareClassicScript(source));
    for (const mode of ["host", "ses"]) {
      expect(await rewrite(moduleSource, { type: "module", mode })).toEqual(prepareModuleSource(moduleSource, mode));
      expect(await prepareModuleOffThread(moduleSource, mode, rewrite)).toEqual(prepareModuleSource(moduleSource, mode));
    }
    // Await worker I/O before asserting: Bun's rejects.toThrow matcher may
    // block worker message delivery while synchronously waiting on a promise.
    let syntaxError;
    try { await rewrite("export const = ;", { type: "module", mode: "ses" }); }
    catch (error) { syntaxError = error; }
    expect(syntaxError).toBeInstanceOf(Error);
    // A syntax error concerns one source only; subsequent requests still work.
    expect(await rewrite("var ok = 1;")).toEqual(prepareClassicScript("var ok = 1;"));
  } finally { rewrite?.close(); }
});

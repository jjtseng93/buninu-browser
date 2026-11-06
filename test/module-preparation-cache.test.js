import { expect, test } from "bun:test";
import { ModulePreparationCache } from "../lib/renderer/module-preparation-cache.js";

const prepared = source => ({ code: `prepared: ${source}`, requests: [] });
const response = source => ({ ok: true, body: new TextEncoder().encode(source) });

test("root module preparation starts early and is consumed by exact source and mode", async () => {
  const calls = [];
  let complete;
  const cache = new ModulePreparationCache((source, options) => {
    calls.push({ source, options });
    return new Promise(resolve => { complete = resolve; });
  }, { mode: "ses" });
  const source = "export const value = 42;";
  expect(cache.preloadResponse(response(source))).toBeTrue();
  expect(cache.preload(source)).toBeTrue();
  expect(calls).toEqual([{ source, options: { type: "module", mode: "ses" } }]);
  expect(cache.consume(source + " ", "ses")).toBeNull();
  expect(cache.consume(source, "host")).toBeNull();
  const promise = cache.consume(source, "ses");
  expect(promise).toBeInstanceOf(Promise);
  expect(cache.size).toBe(0);
  expect(cache.bytes).toBe(0);
  expect(cache.consume(source, "ses")).toBeNull();
  complete(prepared(source));
  expect(await promise).toEqual(prepared(source));
  // A consumed promise cannot reinsert itself when its worker reply arrives.
  expect(cache.size).toBe(0);
});

test("generation cancellation drops cached results and ignores late fetch/worker completion", async () => {
  let generation = 1, complete, calls = 0;
  const cache = new ModulePreparationCache(() => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  }, { mode: "host", isCurrent: () => generation === 1 });
  expect(cache.preload("old source")).toBeTrue();
  generation++;
  expect(cache.preloadResponse(response("late fetch"))).toBeFalse();
  expect(cache.consume("old source", "host")).toBeNull();
  complete(prepared("old source"));
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(cache.size).toBe(0);
  expect(cache.bytes).toBe(0);
  cache.dispose();
  expect(cache.preload("later source")).toBeFalse();
});

test("input entry/byte limits leave oversized or failed resources to normal loading", async () => {
  const calls = [];
  const cache = new ModulePreparationCache(source => {
    calls.push(source); return Promise.resolve(prepared(source));
  }, { mode: "ses", maxEntries: 1, maxBytes: 512, maxSourceBytes: 8 });
  expect(cache.preloadResponse({ ok: false, get body() { throw Error("Must not decode"); } })).toBeFalse();
  expect(cache.preloadResponse({ ok: true, body: new Uint8Array(9) })).toBeFalse();
  expect(cache.preload("12345")).toBeFalse(); // UTF-16 exceeds the source limit.
  expect(cache.preload("one")).toBeTrue();
  expect(cache.preload("two")).toBeFalse();
  await Promise.resolve();
  expect(cache.bytes).toBeLessThanOrEqual(512);
  expect(await cache.consume("one", "ses")).toEqual(prepared("one"));
  expect(cache.preload("two")).toBeTrue();
  expect(calls).toEqual(["one", "two"]);
  cache.dispose();
});

test("rewritten output is counted and oversized retained results are dropped", async () => {
  const cache = new ModulePreparationCache(() => Promise.resolve({ code: "x".repeat(100), requests: [] }),
    { mode: "ses", maxBytes: 300 });
  expect(cache.preload("a")).toBeTrue();
  expect(cache.preload("b")).toBeFalse();
  await Promise.resolve();
  expect(cache.size).toBe(0);
  expect(cache.bytes).toBe(0);
  expect(cache.consume("a", "ses")).toBeNull();
});

test("speculative worker errors are observed without retaining failed promises", async () => {
  const sync = new ModulePreparationCache(() => { throw Error("Cannot send"); }, { mode: "ses" });
  expect(sync.preload("source")).toBeFalse();
  expect(sync.size).toBe(0);
  const async = new ModulePreparationCache(() => Promise.reject(Error("Worker died")), { mode: "ses" });
  expect(async.preload("source")).toBeTrue();
  await Promise.resolve();
  expect(async.consume("source", "ses")).toBeNull();
  expect(async.bytes).toBe(0);
});

test("worker failure after consumption rejects to the ordinary module fallback", async () => {
  let fail;
  const cache = new ModulePreparationCache(() => new Promise((_, reject) => { fail = reject; }), { mode: "host" });
  cache.preload("source");
  const result = Promise.allSettled([cache.consume("source", "host")]);
  fail(Error("Worker died"));
  expect((await result)[0].status).toBe("rejected");
  expect(cache.size).toBe(0);
  expect(cache.bytes).toBe(0);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({ timeout: 20_000 });
  await renderer.start();
  await renderer.call("loadDocument", {
    url: "https://page.test/", source: "<!doctype html><p>idle callbacks</p>",
    contentType: "text/html", status: 200,
  });
  await renderer.call("whenLoaded");
});
afterAll(() => renderer?.close());
const evaluate = (source) => renderer.call("evaluate", source);

test("idle work consumes its monotonic budget and yields", async () => {
  const result = await evaluate(`new Promise(resolve => requestIdleCallback(deadline => {
    const start = performance.now(), before = deadline.timeRemaining();
    // Bound the regression: the old constant deadline must not hang the test.
    while (deadline.timeRemaining() > 0 && performance.now() - start < 30) {}
    resolve({before, after: deadline.timeRemaining(), didTimeout: deadline.didTimeout});
  }))`);
  expect(result.before).toBeGreaterThanOrEqual(0);
  expect(result.before).toBeLessThanOrEqual(10);
  expect(result.after).toBe(0);
  expect(result.didTimeout).toBeFalse();
});

test("an expired timeout has no idle budget", async () => {
  const result = await evaluate(`new Promise(resolve => {
    requestIdleCallback(deadline => resolve({
      didTimeout: deadline.didTimeout, remaining: deadline.timeRemaining()
    }), {timeout: 1});
    const start = performance.now();
    while (performance.now() - start < 20) {}
  })`);
  expect(result).toEqual({ didTimeout: true, remaining: 0 });
});

test("zero timeout does not expire and cancellation prevents delivery", async () => {
  const result = await evaluate(`new Promise(resolve => {
    const calls = [];
    const id = requestIdleCallback(() => calls.push("cancelled"), {timeout: 1});
    cancelIdleCallback(id);
    requestIdleCallback(deadline => {
      calls.push(deadline.didTimeout);
      setTimeout(() => resolve(calls), 10);
    }, {timeout: 0});
    const start = performance.now();
    while (performance.now() - start < 10) {}
  })`);
  expect(result).toEqual([false]);
});

test("idle callbacks validate their Web IDL inputs", async () => {
  expect(await evaluate(`(() => {
    const failures = [];
    for (const args of [[null], ["code"], [() => {}, 1], [() => {}, {timeout: Symbol()}]]) {
      try { requestIdleCallback(...args); failures.push(false); }
      catch (error) { failures.push(error.name === "TypeError"); }
    }
    return failures;
  })()`)).toEqual([true, true, true, true]);
});

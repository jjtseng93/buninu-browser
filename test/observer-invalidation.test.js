import { expect, test } from "bun:test";
import { createLayoutObservers } from "../lib/renderer/layout-observers.js";

test("unchanged geometry skips observer measurements without hiding real changes", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/observer-invalidation.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("observer invalidation integration passed");
}, 30_000);

test("an unchanged border box skips style lookup even after the delivered size is edited", () => {
  const node = {nodeType:1, isConnected:true};
  let flush, styleReads = 0, deliveries = 0, width = 100;
  const observers = createLayoutObservers({
    nodeOf: value => value,
    boundsOf: () => ({width, height:50}),
    computedStyle: () => { styleReads++; return {}; },
    viewport: () => ({devicePixelRatio:2}),
    schedule: callback => { flush = callback; return 1; },
    call: (callback, receiver, args) => callback.apply(receiver, args),
  });
  const observer = new observers.ResizeObserver(([entry]) => {
    deliveries++;
    entry.borderBoxSize[0].inlineSize = -1;
  });
  observer.observe(node, {box:"border-box"});
  flush();
  observers.update(1);
  flush();
  expect([styleReads, deliveries]).toEqual([1, 1]);
  width++;
  observers.update(2);
  flush();
  expect([styleReads, deliveries]).toEqual([2, 2]);
  observers.dispose();
});

import { expect, test } from "bun:test";

test("canvas bitmaps paint, update without DOM mutations, scale, reset and survive detachment", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/canvas-paint.js", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
}, 15_000);

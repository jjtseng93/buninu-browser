import { expect, test } from "bun:test";
test("canvas font and inherited direction use current CSS without per-draw layout", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/canvas-style-snapshot.js", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).pass).toBe(true);
}, 20_000);

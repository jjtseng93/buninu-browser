import { expect, test } from "bun:test";

test("boxless geometry avoids lazy styles while CSSOM, scrolling and visible geometry remain current", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/viewport-bounds.js", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.passed).toBe(true);
  expect(result.checks).toBeGreaterThan(20);
}, 30_000);

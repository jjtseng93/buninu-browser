import { expect, test } from "bun:test";

for (const mode of ["host", "ses"]) test(`computed declarations follow connectivity in ${mode} mode`, async () => {
  const child = Bun.spawn([process.execPath,
    new URL("./fixtures/computed-style-connectivity.js", import.meta.url).pathname, mode],
  { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(stdout).toBe("");
  expect(exit).toBe(0);
}, 20_000);

import { expect, test } from "bun:test";

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

import { expect, test } from "bun:test";

test("geometry reads reuse discovery while newly inserted media stays fresh", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/resource-discovery.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("resource discovery integration passed");
}, 30_000);

import { expect, test } from "bun:test";

test("dynamic image bursts batch paint and release removed, replaced, and late resources", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/image-lifetime.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("image lifetime integration passed");
}, 30_000);

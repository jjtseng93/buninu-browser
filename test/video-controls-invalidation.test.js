import { expect, test } from "bun:test";

test("video controls mutations refresh paint while retaining unchanged geometry", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/video-controls-invalidation.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("video controls paint invalidation passed");
}, 15000);

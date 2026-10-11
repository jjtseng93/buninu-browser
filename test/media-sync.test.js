import { expect, test } from "bun:test";

test("renderer follows output progress, not wall time or submitted audio", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/media-sync.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("media clock integration passed");
}, 30_000);

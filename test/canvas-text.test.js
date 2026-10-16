import { expect, test } from "bun:test";
import { parseCanvasFont, createCanvasTextRenderer } from "../lib/renderer/canvas-text.js";
import { loadGraphics } from "../lib/renderer/page-renderer.js";

test("canvas fonts share shorthand parsing, font units, styles and quoted fallback families", () => {
  expect(parseCanvasFont('italic bold 1.5em "A, B", sans-serif', 20)).toEqual({
    fontSize: 30, fontFamily: ["A, B", "sans-serif"], fontWeight: 700, fontStyle: "italic", fontStretch: 100,
  });
  expect(parseCanvasFont("condensed 2rem monospace", 20, 15).fontSize).toBe(30);
  expect(parseCanvasFont("condensed 12pt monospace").fontStretch).toBe(75);
  expect(parseCanvasFont("condensed 12pt monospace").fontSize).toBe(16);
  expect(parseCanvasFont("invalid")).toBeNull();
  expect(parseCanvasFont("0px serif")).toBeNull();
});

test("canvas text reuses bounded native paragraphs and releases them at document teardown", async () => {
  const { CanvasKit } = await loadGraphics();
  let made = 0, deleted = 0;
  const render = createCanvasTextRenderer(CanvasKit, () => {
    made++;
    return { layout() {}, getMaxIntrinsicWidth: () => 12, getLineMetrics: () => [{ ascent: 8, descent: 2 }],
      getAlphabeticBaseline: () => 8, getIdeographicBaseline: () => 10, getHeight: () => 10,
      delete() { deleted++; } };
  });
  const request = { operation: "measureText", args: ["hello"], style: parseCanvasFont("10px sans-serif"),
    context: {}, settings: { textAlign: "left", textBaseline: "alphabetic", direction: "ltr" } };
  expect(render(request).width).toBe(12);
  render(request);
  expect(made).toBe(1);
  for (let i = 0; i < 200; i++) render({ ...request, args: [String(i)] });
  expect(made - deleted).toBe(128);
  render.clear();
  expect(made).toBe(deleted);
});

test("canvas text uses real shared fonts, aligns and scales glyphs, and saves its text state", async () => {
  // Page scripting runs in its own host process to keep the runner's globals.
  const process = Bun.spawn([Bun.which("bun"), new URL("fixtures/canvas-text.js", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
});

import { beforeAll, expect, test } from "bun:test";
import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { canvasContext, resetCanvas, setCanvasKit } from "../lib/renderer/canvas-2d.js";

beforeAll(async () => {
  const wasmBinary = await Bun.file(new URL("../usr/lib/canvaskit/canvaskit.wasm", import.meta.url)).arrayBuffer();
  setCanvasKit(await CanvasKitInit({ wasmBinary }));
});

function canvas(width = 1, height = 1) {
  return { width, height };
}

/**
 * The probe web-animations-next-lite uses to accept a CSS colour.
 * CanvasKit turns a string it cannot parse into black, so the two reads match
 * and the sample is opaque black. A string it can parse reads back the same
 * way both times.
 */
function sample(context, color) {
  context.fillStyle = "#000";
  context.fillStyle = color;
  const first = context.fillStyle;
  context.fillStyle = "#fff";
  context.fillStyle = color;
  if (first !== context.fillStyle) return null;
  context.fillRect(0, 0, 1, 1);
  const data = [...context.getImageData(0, 0, 1, 1).data];
  context.clearRect(0, 0, 1, 1);
  return data;
}

test("a colour reads back stably, and one CanvasKit cannot parse is black", () => {
  const context = canvasContext(canvas(), "2d");
  expect(context.fillStyle).toBe("#000000");
  expect(sample(context, "not-a-color")).toEqual([0, 0, 0, 255]);
  expect(sample(context, "red")).toEqual([255, 0, 0, 255]);
  expect(sample(context, "rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
  expect(context.getImageData(0, 0, 1, 1).data.length).toBe(4);
  expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
  expect(canvasContext(canvas(), "webgl")).toBeNull();
});

test("the same canvas keeps one context, and changing width clears it", () => {
  const node = canvas(2, 2);
  const context = canvasContext(node, "2d");
  expect(canvasContext(node, "2d")).toBe(context);
  context.fillStyle = "blue";
  context.fillRect(0, 0, 2, 2);
  expect(context.getImageData(1, 1, 1, 1).data[2]).toBe(255);
  node.width = 1;
  resetCanvas(node);
  expect(context.fillStyle).toBe("#000000");
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
});

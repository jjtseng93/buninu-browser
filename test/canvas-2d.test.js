import { beforeAll, expect, test } from "bun:test";
import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { canvasContext, resetCanvas, setCanvasKit, disposeDocumentCanvases } from "../lib/renderer/canvas-2d.js";

let CanvasKit;

beforeAll(async () => {
  const wasmBinary = await Bun.file(new URL("../usr/lib/canvaskit/canvaskit.wasm", import.meta.url)).arrayBuffer();
  CanvasKit = await CanvasKitInit({ wasmBinary });
  setCanvasKit(CanvasKit);
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
  const fill = context.fillRect;
  expect(canvasContext(node, "2d")).toBe(context);
  context.fillStyle = "blue";
  context.fillRect(0, 0, 2, 2);
  expect(context.getImageData(1, 1, 1, 1).data[2]).toBe(255);
  node.width = 1;
  resetCanvas(node);
  expect(context.fillStyle).toBe("#000000");
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
  expect(context.fillRect).toBe(fill);
  // A method kept before a bitmap reset must draw into the new bitmap.
  context.fillStyle = "red";
  fill(0, 0, 1, 1);
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
});

test("gradient and pattern facades hide native shaders while style identity and drawing survive", () => {
  const node = canvas(2, 2);
  const context = canvasContext(node, "2d");
  const gradient = context.createLinearGradient(0, 0, 2, 0);
  let offsetReads = 0, colorReads = 0;
  gradient.addColorStop({ gradient, valueOf() { offsetReads++; return 0; } },
    { gradient, toString() { colorReads++; return "red"; } });
  expect([offsetReads, colorReads]).toEqual([1, 1]);
  gradient.addColorStop(1, "red");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 2, 2);
  expect(context.fillStyle).toBe(gradient);
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
  expect(Object.keys(gradient)).toEqual(["addColorStop"]);
  for (const name of ["Td", "pe", "ie", "oe"]) expect(gradient[name]).toBeUndefined();
  let invoked = false;
  context.fillStyle = { pe() { invoked = true; throw new Error("private shader protocol"); } };
  context.fillRect(0, 0, 1, 1);
  expect(invoked).toBeFalse();
  expect(context.fillStyle).toBe(gradient);
  context.strokeStyle = gradient;
  expect(context.strokeStyle).toBe(gradient);
  context.save();
  context.fillStyle = "blue";
  context.strokeStyle = "blue";
  context.restore();
  expect(context.fillStyle).toBe(gradient);
  expect(context.strokeStyle).toBe(gradient);
  const radial = context.createRadialGradient(0, 0, 0, 1, 1, 2);
  expect(Object.keys(radial)).toEqual(["addColorStop"]);
  const pattern = context.createPattern({}, "repeat");
  expect(Object.keys(pattern)).toEqual(["setTransform"]);
  for (const name of ["Td", "qf", "pe", "ie", "oe"]) expect(pattern[name]).toBeUndefined();
  resetCanvas(node);
  expect(context.fillStyle).toBe("#000000");
});

test("discarding a document frees its connected and detached canvas pixel buffers", () => {
  const malloc = CanvasKit._malloc;
  const free = CanvasKit._free;
  const allocations = new Map();
  let pixelBytes = 0;
  CanvasKit._malloc = (size) => {
    const pointer = malloc(size);
    allocations.set(pointer, size);
    pixelBytes += size;
    return pointer;
  };
  CanvasKit._free = (pointer) => {
    pixelBytes -= allocations.get(pointer) ?? 0;
    allocations.delete(pointer);
    return free(pointer);
  };
  const document = {};
  try {
    // Ownership follows ownerDocument, even if an element was never inserted.
    const nodes = Array.from({ length: 8 }, () => ({ ownerDocument: document, width: 400, height: 300 }));
    const contexts = nodes.map(node => canvasContext(node, "2d"));
    expect(pixelBytes).toBe(8 * 400 * 300 * 4);
    for (const context of contexts) context.fillRect(0, 0, 1, 1);
    disposeDocumentCanvases(document);
    expect(pixelBytes).toBe(0);
    disposeDocumentCanvases(document);
    expect(pixelBytes).toBe(0);
    expect(() => contexts[0].fillRect(0, 0, 1, 1)).toThrow("discarded");
  } finally {
    disposeDocumentCanvases(document);
    CanvasKit._malloc = malloc;
    CanvasKit._free = free;
  }
});

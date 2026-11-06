import { expect, test } from "bun:test";
import { buildDisplayList } from "../lib/paint/display-list.js";

function textList(styles) {
  return buildDisplayList({
    generation: 1, width: 200, height: 20, boxes: [],
    fragments: [{ y: 0, height: 20, runs: styles.map((style, index) => ({
      type: "text", nodeId: index + 1, text: "text", x: index * 40, width: 40, style,
    })) }],
  });
}

function fontStyle(overrides = {}) {
  return {
    fontFamily: Object.freeze(["Example", "sans-serif"]),
    fontSize: 18, fontWeight: 600, fontStyle: "italic", fontStretch: 125,
    color: "rgba(0, 0, 0, 1)", ...overrides,
  };
}

test("immutable styles share a frozen font across runs and repeated paints without changing output", () => {
  const style = Object.freeze(fontStyle());
  const first = textList([style, style]);
  const next = textList([style, style]);
  const uncached = textList([fontStyle(), fontStyle()]);
  expect(first).toEqual(uncached);
  expect(JSON.stringify(next)).toBe(JSON.stringify(uncached));
  expect(first.items[0].font).toBe(first.items[1].font);
  expect(next.items[0].font).toBe(first.items[0].font);
  expect(Object.isFrozen(first.items[0].font)).toBe(true);
  expect(Object.isFrozen(first.items[0].font.family)).toBe(true);
  expect(() => { first.items[0].font.size = 99; }).toThrow(TypeError);
});

test("replacement computed styles create new font descriptors and preserve old frames", () => {
  const before = Object.freeze(fontStyle());
  const after = Object.freeze(fontStyle({ fontSize: 24, fontFamily: Object.freeze(["Other"]) }));
  const oldFrame = textList([before]);
  const newFrame = textList([after]);
  expect(newFrame.items[0].font).not.toBe(oldFrame.items[0].font);
  expect(newFrame.items[0].font).toMatchObject({ family: ["Other"], size: 24 });
  expect(oldFrame.items[0].font).toMatchObject({ family: ["Example", "sans-serif"], size: 18 });
});

test("external mutable styles remain fresh after scalar and family changes", () => {
  const style = fontStyle();
  const oldFrame = textList([style]);
  style.fontSize = 32;
  style.fontFamily = ["Mutable replacement"];
  const newFrame = textList([style]);
  expect(newFrame.items[0].font).toMatchObject({ family: ["Mutable replacement"], size: 32 });
  expect(oldFrame.items[0].font.size).toBe(18);
  expect(newFrame.items[0].font).not.toBe(oldFrame.items[0].font);
  expect(Object.isFrozen(newFrame.items[0].font)).toBe(true);
  expect(Object.isFrozen(style.fontFamily)).toBe(true);
});

test("frozen styles with accessor or inherited font state do not cache changing values", () => {
  let size = 18;
  const accessor = Object.freeze({ ...fontStyle(), get fontSize() { return size; } });
  const prototype = fontStyle();
  const inherited = Object.freeze(Object.create(prototype));
  const first = textList([accessor, inherited]);
  size = 27;
  prototype.fontWeight = 900;
  const next = textList([accessor, inherited]);
  expect(first.items[0].font.size).toBe(18);
  expect(next.items[0].font.size).toBe(27);
  expect(first.items[1].font.weight).toBe(600);
  expect(next.items[1].font.weight).toBe(900);
});

import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

/**
 * Grid cases ported from TermDOM tests/grid.test.ts
 * (bikeshaving/termdom@b92f36d5f3d83770f3ea8c38fdeae0a192dc235e, MIT).
 * TermDOM renders into a 30-cell terminal where one cell is 1px and every
 * character one cell wide and one line tall; the fixture reproduces that, and
 * the hand-derived expected values are kept as they are upstream.
 */
function render(html, width = 30) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width,
    lineHeight: 1,
    measureText: (text) => text.length,
    fontMetrics: () => ({ ascent: 0.8, height: 1 }),
  });
  const boxOf = (element) => {
    const box = layout.boxes.find((candidate) => tree.nodesById.get(candidate.nodeId)?.domNode === element);
    return { left: box.x, top: box.y, width: box.width, height: box.height };
  };
  window.happyDOM.abort();
  return {
    item: (index) => boxOf(document.querySelectorAll("i")[index]),
    items: () => [...document.querySelectorAll("i")].map(boxOf),
  };
}

const grid = (styles, items) => `<div id="g" style='display:grid;${styles}'>${items}</div>`;
const letters = (count, styles = "") => Array.from({ length: count },
  (_, index) => `<i style='${styles}'>${String.fromCharCode(97 + index)}</i>`).join("");

// Explicit tracks (css-grid-2 §7.2)

test("a length track list places items at the lengths it states", () => {
  const { item } = render(grid("grid-template-columns: 6px 4px", letters(2)));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 6, height: 1 });
  expect(item(1)).toEqual({ left: 6, top: 0, width: 4, height: 1 });
});

test("a percentage track resolves against the container's content box", () => {
  const { item } = render(grid("grid-template-columns: 50% 50%; width: 20px", letters(2)));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 10, height: 1 });
  expect(item(1)).toEqual({ left: 10, top: 0, width: 10, height: 1 });
});

test("fr shares the leftover space in proportion to its factor", () => {
  const { item } = render(grid("grid-template-columns: 6px 1fr 2fr", letters(3)));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 6, height: 1 });
  expect(item(1)).toEqual({ left: 6, top: 0, width: 8, height: 1 });
  expect(item(2)).toEqual({ left: 14, top: 0, width: 16, height: 1 });
});

test("a flex factor below one leaves part of the free space unclaimed", () => {
  const { item } = render(grid("grid-template-columns: 0.5fr; width: 20px", letters(1)));
  expect(item(0).width).toBe(10);
});

test("auto tracks size to their content and share what is left", () => {
  const { item } = render(grid("grid-template-columns: auto auto", letters(2)));
  expect(item(0).width).toBe(15);
  expect(item(1)).toEqual({ left: 15, top: 0, width: 15, height: 1 });
});

test("min-content and max-content size a track to its content", () => {
  for (const keyword of ["min-content", "max-content"]) {
    const { item } = render(grid(`grid-template-columns: ${keyword} auto`, "<i>unbreakab</i><i>x</i>"));
    expect(`${keyword}: ${item(0).width} ${item(1).width}`).toBe(`${keyword}: 9 21`);
  }
});

test("minmax clamps a track between its two breadths", () => {
  const { item } = render(grid("grid-template-columns: minmax(4px, 8px) minmax(2px, 1fr)", letters(2)));
  expect(item(0).width).toBe(8);
  expect(item(1)).toEqual({ left: 8, top: 0, width: 22, height: 1 });
});

test("minmax with an intrinsic minimum floors the track at its content", () => {
  const { item } = render(grid("grid-template-columns: minmax(min-content, 4px) 5px", "<i>unbreakab</i><i>x</i>"));
  expect(item(0).width).toBe(9);
  expect(item(1).left).toBe(9);
});

test("fit-content caps a track at its argument", () => {
  const { item } = render(grid("grid-template-columns: fit-content(6px) 5px", "<i>aaa bbb</i><i>x</i>"));
  expect(item(0).width).toBe(6);
  expect(item(0).height).toBe(2);
});

test("fit-content never clamps below the content's own minimum", () => {
  const { item } = render(grid("grid-template-columns: fit-content(4px) 5px", "<i>unbreakab</i><i>x</i>"));
  expect(item(0).width).toBe(9);
});

test("repeat(N) states the same track N times", () => {
  const { items } = render(grid("grid-template-columns: repeat(3, 6px)", letters(3)));
  expect(items().map((box) => box.left)).toEqual([0, 6, 12]);
});

test("repeat(auto-fill) fits as many tracks as the container holds", () => {
  // Four 7-cell tracks fit in 30; a fifth item therefore starts row two.
  const { items } = render(grid("grid-template-columns: repeat(auto-fill, 7px)", letters(5)));
  expect(items().map((box) => [box.left, box.top])).toEqual([[0, 0], [7, 0], [14, 0], [21, 0], [0, 1]]);
});

test("repeat(auto-fill) counts the gaps between its tracks", () => {
  // 7 + 2 per repetition: three tracks fit, so the fourth item wraps.
  const { items } = render(grid("grid-template-columns: repeat(auto-fill, 7px); column-gap: 2px", letters(4)));
  expect(items().map((box) => [box.left, box.top])).toEqual([[0, 0], [9, 0], [18, 0], [0, 1]]);
});

test("repeat(auto-fit) collapses the tracks no item landed in", () => {
  const { items } = render(grid("grid-template-columns: repeat(auto-fit, 7px)", letters(2)));
  expect(items().map((box) => box.left)).toEqual([0, 7]);
  // Collapsed tracks and their gutters take no space, so centering sees 14px of tracks.
  const centered = render(grid("grid-template-columns: repeat(auto-fit, 7px); column-gap: 2px; justify-content: center", letters(2)));
  expect(centered.items().map((box) => [box.left, box.width])).toEqual([[7, 7], [16, 7]]);
});

test("grid-template-rows sizes the rows", () => {
  const { item } = render(grid("grid-template-columns: 5px; grid-template-rows: 2px 3px", letters(2)));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 5, height: 2 });
  expect(item(1)).toEqual({ left: 0, top: 2, width: 5, height: 3 });
});

test("a row sized auto takes the height of the tallest item in it", () => {
  const { item } = render(grid("grid-template-columns: 4px 4px", "<i>aa bb cc</i><i>x</i>"));
  expect(item(0).height).toBe(3);
  expect(item(1).height).toBe(3);
});

// Line-based placement (css-grid-2 §8.3)

test("line numbers place an item between them", () => {
  const { item } = render(grid("grid-template-columns: 5px 5px 5px", `<i style="grid-column: 2 / 3">a</i>`));
  expect(item(0)).toEqual({ left: 5, top: 0, width: 5, height: 1 });
});

test("a negative line number counts back from the explicit grid's end", () => {
  const { item } = render(grid("grid-template-columns: 5px 5px 5px", `<i style="grid-column: 2 / -1">a</i>`));
  expect(item(0)).toEqual({ left: 5, top: 0, width: 10, height: 1 });
});

test("two negative lines place an item at the end of the grid", () => {
  const { item } = render(grid("grid-template-columns: 5px 5px 5px", `<i style="grid-column: -3 / -2">a</i>`));
  expect(item(0)).toEqual({ left: 5, top: 0, width: 5, height: 1 });
});

test("lines given out of order are swapped", () => {
  const { item } = render(grid("grid-template-columns: 5px 5px 5px", `<i style="grid-column: 3 / 1">a</i>`));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 10, height: 1 });
});

test("a start and end on the same line span one track", () => {
  const { item } = render(grid("grid-template-columns: 5px 5px", `<i style="grid-column: 2 / 2">a</i>`));
  expect(item(0)).toEqual({ left: 5, top: 0, width: 5, height: 1 });
});

test("span N widens an item from its start line", () => {
  const { item } = render(grid("grid-template-columns: 4px 4px 4px", `<i style="grid-column: 1 / span 2">a</i>`));
  expect(item(0).width).toBe(8);
});

test("span N before a definite end line places the start", () => {
  const { item } = render(grid("grid-template-columns: 4px 4px 4px", `<i style="grid-column: span 2 / 4">a</i>`));
  expect(item(0)).toEqual({ left: 4, top: 0, width: 8, height: 1 });
});

test("an end line alone spans the one track before it", () => {
  const { item } = render(grid("grid-template-columns: 4px 4px 4px", `<i style="grid-column-end: 3">a</i>`));
  expect(item(0)).toEqual({ left: 4, top: 0, width: 4, height: 1 });
});

test("two spans discard the end one", () => {
  const { item } = render(grid("grid-template-columns: 4px 4px 4px", `<i style="grid-column: span 2 / span 3">a</i>`));
  expect(item(0)).toEqual({ left: 0, top: 0, width: 8, height: 1 });
});

// Auto-placement (css-grid-2 §8.5)

test("items fill the rows in order", () => {
  const { items } = render(grid("grid-template-columns: 4px 4px", letters(5)));
  expect(items().map((box) => [box.left, box.top])).toEqual([[0, 0], [4, 0], [0, 1], [4, 1], [0, 2]]);
});

test("an item too wide for the row left starts the next one", () => {
  const { items } = render(grid("grid-template-columns: repeat(3, 4px)", `<i>a</i><i style="grid-column: span 3">b</i><i>c</i>`));
  expect(items().map((box) => [box.left, box.top])).toEqual([[0, 0], [0, 1], [0, 2]]);
});

test("sparse packing never goes back for a hole it left", () => {
  const { items } = render(grid("grid-template-columns: repeat(3, 4px)",
    `<i style="grid-column: 2 / 4">a</i><i style="grid-column: span 2">b</i><i>c</i>`));
  expect(items().map((box) => [box.left, box.top])).toEqual([[4, 0], [0, 1], [8, 1]]);
});

test("dense packing goes back and fills the hole", () => {
  const { items } = render(grid("grid-template-columns: repeat(3, 4px); grid-auto-flow: row dense",
    `<i style="grid-column: 2 / 4">a</i><i style="grid-column: span 2">b</i><i>c</i>`));
  expect(items().map((box) => [box.left, box.top])).toEqual([[4, 0], [0, 1], [0, 0]]);
});

test("implicit rows take their size from grid-auto-rows, cycling", () => {
  const { items } = render(grid("grid-template-columns: 4px 4px; grid-auto-rows: 2px", letters(3)));
  expect(items()[2]).toEqual({ left: 0, top: 2, width: 4, height: 2 });
  const cycling = render(grid("grid-template-columns: 4px; grid-auto-rows: 1px 3px", letters(4)));
  expect(cycling.items().map((box) => [box.top, box.height])).toEqual([[0, 1], [1, 3], [4, 1], [5, 3]]);
});

test("implicit columns are created past the explicit grid", () => {
  const { item } = render(grid("grid-template-columns: 4px; grid-auto-columns: 6px", `<i style="grid-column: 2">a</i>`));
  expect(item(0)).toEqual({ left: 4, top: 0, width: 6, height: 1 });
});

// Gaps (css-align-3)

test("column-gap separates the columns and comes off the free space", () => {
  const { items } = render(grid("grid-template-columns: 1fr 1fr; column-gap: 2px", letters(2)));
  expect(items()[0].width).toBe(14);
  expect(items()[1].left).toBe(16);
});

test("row-gap and the gap shorthands separate rows and columns", () => {
  expect(render(grid("grid-template-columns: 4px; grid-auto-rows: 1px; row-gap: 1px", letters(2))).items()[1].top).toBe(2);
  for (const property of ["gap", "grid-gap"]) {
    const { items } = render(grid(`grid-template-columns: 4px 4px; grid-auto-rows: 1px; ${property}: 1px 2px`, letters(4)));
    expect(`${property}: ${items()[1].left} ${items()[2].top}`).toBe(`${property}: 6 2`);
  }
});

test("a gap is outside every area unless an item spans it", () => {
  const { items } = render(grid("grid-template-columns: 4px 4px; column-gap: 3px", letters(2)));
  expect([items()[0].width, items()[1].left]).toEqual([4, 7]);
  const spanning = render(grid("grid-template-columns: 4px 4px; column-gap: 3px", `<i style="grid-column: 1 / 3">a</i>`));
  expect(spanning.item(0).width).toBe(11);
});

// Alignment (css-grid-2 §10)

test("an item stretches to its area by default and justify-items can center it", () => {
  expect(render(grid("grid-template-columns: 10px; grid-template-rows: 4px", letters(1))).item(0))
    .toEqual({ left: 0, top: 0, width: 10, height: 4 });
  expect(render(grid("grid-template-columns: 8px; justify-items: center", "<i>ab</i>")).item(0))
    .toEqual({ left: 3, top: 0, width: 2, height: 1 });
});

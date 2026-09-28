import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

/**
 * Flexbox cases ported from TermDOM tests/flex.test.ts
 * (bikeshaving/termdom@b92f36d5f3d83770f3ea8c38fdeae0a192dc235e, MIT).
 * TermDOM's expectations are hand-derived from css-flexbox-1; they are kept
 * as-is and re-expressed as HTML/CSS fixtures in CSS pixels.
 */
function flex(html, css) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document, [`div { box-sizing: border-box } ${css}`]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 400,
    lineHeight: 10,
    measureText: (text) => text.length * 10,
    fontMetrics: () => ({ ascent: 8, height: 10 }),
  });
  const rect = (selector) => {
    const element = document.querySelector(selector);
    const box = layout.boxes.find((candidate) => tree.nodesById.get(candidate.nodeId)?.domNode === element);
    return { left: box.x, top: box.y, width: box.width, height: box.height };
  };
  return { rect, done: () => window.happyDOM.abort() };
}

const ROOT = `#root { display:flex; width:100px; height:20px }`;

test("flex-basis auto falls back to the main size property (§7.2.3)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #a { width:30px; height:10px; flex:0 0 auto }`);
  expect(rect("#a").width).toBe(30);
  done();
});

test("a definite flex-basis wins over the width property (§7.2.3)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #a { width:30px; height:10px; flex:0 0 50px }`);
  expect(rect("#a").width).toBe(50);
  done();
});

test("flex-basis auto with width auto sizes to max-content (§7.2.3)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"><div id="c"></div></div></div>`,
    `${ROOT} #a { display:flex; flex:0 0 auto } #c { width:25px; height:10px }`);
  expect(rect("#a").width).toBe(25);
  done();
});

test("max-width freezes a growing item and its surplus goes to the others (§9.7)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div><div id="b"></div></div>`,
    `${ROOT} #a, #b { flex:1 1 0; height:10px } #a { max-width:30px }`);
  expect([rect("#a").width, rect("#b").width, rect("#a").left, rect("#b").left]).toEqual([30, 70, 0, 30]);
  done();
});

test("min-width freezes a growing item and the rest share what is left (§9.7)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div><div id="b"></div></div>`,
    `${ROOT} #a, #b { flex-grow:1; flex-basis:0; height:10px } #a { min-width:80px }`);
  expect([rect("#a").width, rect("#b").width]).toEqual([80, 20]);
  done();
});

test("min-width freezes a shrinking item and the rest absorb the overflow (§9.7)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div><div id="b"></div></div>`,
    `${ROOT} #a, #b { flex-basis:80px; flex-shrink:1; height:10px } #a { min-width:60px }`);
  expect([rect("#a").width, rect("#b").width, rect("#b").left]).toEqual([60, 40, 60]);
  done();
});

test("auto margins center an item on the main axis and a single one absorbs free space (§9.5)", () => {
  const both = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #a { width:20px; height:10px; flex-shrink:0; margin:0 auto }`);
  expect(both.rect("#a").left).toBe(40);
  both.done();
  const single = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #a { width:20px; height:10px; flex-shrink:0; margin-left:auto }`);
  expect(single.rect("#a").left).toBe(80);
  single.done();
});

test("auto margins center an item on the cross axis (§9.5)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #a { width:20px; height:10px; margin:auto 0 }`);
  expect(rect("#a").top).toBe(5);
  done();
});

test("auto margins take priority over justify-content (§9.5)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div></div>`,
    `${ROOT} #root { justify-content:flex-end } #a { width:20px; height:10px; flex-shrink:0; margin-right:auto }`);
  expect(rect("#a").left).toBe(0);
  done();
});

test("column-gap separates items and is removed before flexible lengths (css-align-3)", () => {
  const fixed = flex(`<div id="root"><div id="a"></div><div id="b"></div><div id="c"></div></div>`,
    `#root { display:flex; width:40px; column-gap:3px } #a, #b, #c { width:6px; height:1px; flex-shrink:0 }`);
  expect(["#a", "#b", "#c"].map((selector) => fixed.rect(selector).left)).toEqual([0, 9, 18]);
  fixed.done();
  const flexible = flex(`<div id="root"><div id="a"></div><div id="b"></div><div id="c"></div></div>`,
    `#root { display:flex; width:32px; column-gap:2px } #a, #b, #c { flex:1 1 0; height:1px }`);
  const widths = ["#a", "#b", "#c"].map((selector) => flexible.rect(selector).width);
  expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(28);
  flexible.done();
});

test("a gap counts against the line when deciding where to wrap (css-align-3)", () => {
  const { rect, done } = flex(`<div id="root"><div id="a"></div><div id="b"></div><div id="c"></div></div>`,
    `#root { display:flex; flex-wrap:wrap; align-items:flex-start; width:20px; gap:1px 2px }
     #a, #b, #c { width:8px; height:1px; flex-shrink:0 }`);
  expect([rect("#b").left, rect("#b").top, rect("#c").left, rect("#c").top]).toEqual([10, 0, 0, 2]);
  done();
});

test("the automatic minimum size floors shrinking at min-content (§4.5)", () => {
  // TermDOM uses 15/4-cell words in a 12-cell row; here 10px per character.
  const floored = flex(`<div id="root"><div id="a">aaaaaaaaaaaaaaa</div><div id="b">aaaa</div></div>`,
    `#root { display:flex; width:120px }`);
  expect([floored.rect("#a").width, floored.rect("#b").width, floored.rect("#b").left]).toEqual([150, 40, 150]);
  floored.done();
  const wrappable = flex(`<div id="root"><div id="a">aaaaa aaaaa aaaa</div><div id="b">aaaa</div></div>`,
    `#root { display:flex; width:120px }`);
  expect(wrappable.rect("#a").width).toBeLessThan(160);
  expect(wrappable.rect("#a").width).toBeGreaterThanOrEqual(50);
  expect(wrappable.rect("#a").width + wrappable.rect("#b").width).toBeLessThanOrEqual(120);
  wrappable.done();
  const optedOut = flex(`<div id="root"><div id="a">aaaaaaaaaaaaaaa</div><div id="b">aaaa</div></div>`,
    `#root { display:flex; width:120px } #a { min-width:0 }`);
  expect(optedOut.rect("#a").width).toBeLessThan(150);
  optedOut.done();
  const rigid = flex(`<div id="root"><div id="a">aaaaaaaaaaaaaaa</div></div>`,
    `#root { display:flex; width:120px } #a { flex-shrink:0 }`);
  expect(rigid.rect("#a").width).toBe(150);
  rigid.done();
});

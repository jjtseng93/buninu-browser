import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { elementAtPoint, elementBounds, hitTest, interactiveRegions } from "../lib/input/hit-test.js";
import { buildDisplayList } from "../lib/paint/display-list.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

test("creates separate clickable regions for links sharing a line", () => {
  const { document, window } = parseHTMLDocument(
    `<body><a href="first">first</a> gap <a href="second">second</a></body>`,
    "https://example.test/root/",
  );
  const tree = new RenderTreeBuilder().build(document);
  const layout = layoutText(tree);
  const regions = interactiveRegions(tree, layout, { x: 0, y: 0 }, { width: 800, height: 600 });

  expect(regions).toHaveLength(2);
  expect(regions.map((region) => region.element.getAttribute("href"))).toEqual(["first", "second"]);
  expect(regions[0].rects[0].right).toBeLessThan(regions[1].rects[0].left);
  expect(hitTest(tree, layout, regions[1].rects[0].left + 1, regions[1].rects[0].top + 1, { x: 0, y: 0 }, { width: 800, height: 600 })?.element.getAttribute("href")).toBe("second");
  window.happyDOM.abort();
});

test("finds content bounds for fragment navigation targets", () => {
  const { document, window } = parseHTMLDocument(
    `<body><pre>before\nbefore\nbefore</pre><section id="target"><h2>Target</h2></section></body>`,
  );
  const tree = new RenderTreeBuilder().build(document);
  const layout = layoutText(tree);
  const bounds = elementBounds(tree, layout, document.getElementById("target"));

  expect(bounds.top).toBeGreaterThan(12);
  expect(bounds.height).toBeGreaterThan(0);
  window.happyDOM.abort();
});

test("hit testing accounts for viewport scrolling", () => {
  const { document, window } = parseHTMLDocument(
    `<body><pre>line 0\nline 1\nline 2\n<a href="target">target</a></pre></body>`,
  );
  const tree = new RenderTreeBuilder().build(document);
  const layout = layoutText(tree);
  const scroll = { x: 0, y: 62 };
  const regions = interactiveRegions(tree, layout, scroll, { width: 800, height: 100 });

  expect(regions).toHaveLength(1);
  const rect = regions[0].rects[0];
  expect(hitTest(tree, layout, rect.left + 1, rect.top + 1, scroll, { width: 800, height: 100 })?.element.getAttribute("href")).toBe("target");
  window.happyDOM.abort();
});

test("an overlapping broad text region does not steal a form control's click", () => {
  const { document, window } = parseHTMLDocument(`<button id="button">+</button><textarea id="field"></textarea>`);
  const button = document.getElementById("button");
  const field = document.getElementById("field");
  const tree = { nodesById: new Map([
    [1, { domNode: button, style: {} }],
    [2, { domNode: field, style: {} }],
  ]) };
  const layout = {
    fragments: [{ y: 0, height: 40, runs: [{ nodeId: 1, x: 0, width: 500 }] }],
    boxes: [
      { nodeId: 1, x: 0, y: 0, width: 40, height: 40 },
      { nodeId: 2, x: 50, y: 0, width: 400, height: 40 },
    ],
  };
  expect(hitTest(tree, layout, 100, 20, { x: 0, y: 0 }, { width: 500, height: 100 })?.element).toBe(field);
  window.happyDOM.abort();
});

test("hidden and pointer-events: none boxes let clicks through, but their opted-in descendants take them", () => {
  const { document, window } = parseHTMLDocument(
    `<body>
      <div class="menu"><a href="through">through</a> <a class="open" href="open">open</a></div>
      <div style="visibility: hidden"><a href="hidden">hidden</a> <button>ghost</button>
        <a style="visibility: visible" href="shown">shown</a></div>
      <a href="plain">plain</a>
    </body>`,
  );
  const tree = new RenderTreeBuilder().build(document, new StyleEngine().compute(document, [`.menu { pointer-events: none } .menu .open { pointer-events: auto }`]));
  const layout = layoutText(tree);
  const regions = interactiveRegions(tree, layout, { x: 0, y: 0 }, { width: 800, height: 600 });

  expect(regions.map((region) => region.element.getAttribute("href") ?? region.element.tagName)).toEqual(["open", "shown", "plain"]);
  window.happyDOM.abort();
});

test("pointer events target the topmost element painted at a point, whatever its tag", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
    <table><tr><td id="cell" style="width:100px;height:50px"><span id="label">tile</span></td></tr></table>
    <div id="under" style="height:40px"></div>
    <div id="over" style="position:absolute;top:60px;left:0;width:50px;height:20px"></div>
    <div id="ghost" style="position:absolute;top:60px;left:50px;width:50px;height:20px;pointer-events:none"></div>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, { x: 0, y: 0, width: 400, lineHeight: 20, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }) });
  const displayList = buildDisplayList(layout, tree);
  const at = (x, y) => elementAtPoint(tree, displayList, x, y, { x: 0, y: 0 })?.id ?? null;
  const label = layout.fragments.flatMap((fragment) => fragment.runs.map((run) => ({ run, fragment })))
    .find(({ run }) => tree.nodesById.get(run.nodeId)?.domNode?.parentElement?.id === "label");
  // Text hits its element; the rest of the cell hits the cell.
  expect(at(label.run.x + 1, label.fragment.y + 1)).toBe("label");
  expect(at(label.run.x + label.run.width + 20, label.fragment.y + 1)).toBe("cell");
  // A positioned box paints over the in-flow one; pointer-events:none passes through.
  expect(at(10, 65)).toBe("over");
  expect(at(60, 65)).toBe("under");
  window.happyDOM.abort();
});

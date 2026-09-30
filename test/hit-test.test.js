import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { elementBounds, hitTest, interactiveRegions } from "../lib/input/hit-test.js";
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

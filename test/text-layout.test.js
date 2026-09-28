import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

test("creates positioned immutable line fragments with fixed-column wrapping", () => {
  const { document, window } = parseHTMLDocument(
    `<body>1234567890ABCDEFGHIJ<br>中文😀abcdef</body>`,
  );
  const tree = new RenderTreeBuilder().build(document);
  const layout = layoutText(tree, { columns: 10, x: 4, y: 8, lineHeight: 20 });

  expect(layout.generation).toBe(tree.generation);
  expect(layout.fragments.map((fragment) => fragment.text)).toEqual([
    "1234567890",
    "ABCDEFGHIJ",
    "中文😀abcd",
    "ef",
  ]);
  expect(layout.fragments.map((fragment) => fragment.y)).toEqual([8, 28, 48, 68]);
  expect(layout.fragments[0]).toMatchObject({
    id: `${tree.generation}:0`,
    type: "line",
    x: 4,
    width: 10,
    height: 20,
  });
  expect(layout.fragments[0].nodeIds.length).toBeGreaterThan(0);
  expect(Object.isFrozen(layout)).toBeTrue();
  expect(Object.isFrozen(layout.fragments)).toBeTrue();
  expect(Object.isFrozen(layout.fragments[0])).toBeTrue();
  window.happyDOM.abort();
});

test("uses block boundaries, collapses normal whitespace and preserves preformatted lines", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <h1>  heading  text </h1>
    <span> inline </span><strong> content </strong>
    <pre>first\n  second</pre>
  </body>`);
  const layout = layoutText(new RenderTreeBuilder().build(document), { columns: 40 });

  expect(layout.fragments.map((fragment) => fragment.text)).toEqual([
    "heading text",
    "inline content",
    "first",
    "  second",
  ]);
  window.happyDOM.abort();
});

test("layout generation follows rebuilt render trees", () => {
  const { document, window } = parseHTMLDocument(`<body>before</body>`);
  const builder = new RenderTreeBuilder();
  const first = layoutText(builder.build(document));
  document.body.textContent = "after";
  const second = layoutText(builder.build(document));

  expect(second.generation).toBe(first.generation + 1);
  expect(second.fragments[0].text).toBe("after");
  window.happyDOM.abort();
});

test("uses viewport width and block margin, padding, width geometry", () => {
  const { document, window } = parseHTMLDocument(
    `<body><div style="margin:10px;padding:5px;width:40px">abcdef</div></body>`,
  );
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 100,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => fragment.text)).toEqual(["abcd", "ef"]);
  expect(layout.fragments.map((fragment) => [fragment.x, fragment.y])).toEqual([[15, 15], [15, 35]]);
  expect(layout.boxes[0]).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
  expect(layout.height).toBe(70);
  window.happyDOM.abort();
});

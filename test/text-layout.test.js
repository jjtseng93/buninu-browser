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

test("measures and positions inline runs with their own computed styles", () => {
  const { document, window } = parseHTMLDocument(
    `<body><span style="color:red;font-size:30px">aa</span><strong>bb</strong></body>`,
  );
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text, style) => text.length * (style?.fontSize === 30 ? 15 : 10),
  });
  const [red, bold] = layout.fragments[0].runs;

  expect(red).toMatchObject({ text: "aa", x: 0, width: 30 });
  expect(red.style.color).toBe("rgba(255, 0, 0, 1)");
  expect(bold).toMatchObject({ text: "bb", x: 30, width: 20 });
  expect(bold.style.fontWeight).toBe(700);
  window.happyDOM.abort();
});

test("centers max-width blocks with auto margins", () => {
  const { document, window } = parseHTMLDocument(
    `<body><div style="max-width:50%;margin:0 auto">centered</div></body>`,
  );
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });

  expect(layout.boxes[0]).toMatchObject({ x: 50, width: 100 });
  expect(layout.fragments[0].x).toBe(50);
  window.happyDOM.abort();
});

test("lays out image replaced elements from intrinsic and HTML dimensions", () => {
  const { document, window } = parseHTMLDocument(`<body>before<img src="pixel.png" width="40">after</body>`);
  const image = document.querySelector("img");
  const resources = new WeakMap([[image, { width: 20, height: 10 }]]);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles, resources);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });
  const imageRun = layout.fragments[0].runs.find((run) => run.type === "image");

  expect(imageRun).toMatchObject({ width: 40, height: 20 });
  expect(imageRun.x).toBe(60);
  expect(layout.fragments[0].height).toBe(31);
  window.happyDOM.abort();
});

test("aligns inline content and flattens a basic flex row", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <nav style="display:flex;justify-content:center;gap:20px"><div>one</div><div>two</div></nav>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => fragment.text)).toEqual(["one two"]);
  expect(layout.fragments[0].x).toBe(60);
  expect(layout.fragments[0].runs.at(-1).x).toBe(110);
  window.happyDOM.abort();
});

test("wraps measured text at word boundaries before hard grapheme breaks", () => {
  const { document, window } = parseHTMLDocument(`<body>hello world abcdefghij</body>`);
  const layout = layoutText(new RenderTreeBuilder().build(document), {
    x: 0,
    y: 0,
    width: 70,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => fragment.text)).toEqual([
    "hello",
    "world",
    "abcdefg",
    "hij",
  ]);
  window.happyDOM.abort();
});

test("distributes remaining flex-row space between direct children", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <nav style="display:flex;justify-content:space-between;gap:10px"><span>left</span><span>right</span></nav>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });
  const runs = layout.fragments[0].runs;

  expect(runs[0]).toMatchObject({ text: "left", x: 0, width: 40 });
  expect(runs.at(-1)).toMatchObject({ text: "right", x: 150, width: 50 });
  window.happyDOM.abort();
});

test("places direct flex-column children on separate lines with column gap", () => {
  const { document, window } = parseHTMLDocument(`<body><div class="prereq-command">
    <span class="prereq-platform">macOS / Linux</span>
    <button class="command"><span>$</span><span>curl -fsSL</span><span>Copy</span></button>
  </div></body>`);
  const styles = new StyleEngine().compute(document, [`
    .prereq-command { display:flex; flex-direction:column; gap:6px }
    .command { display:inline-flex; gap:8px }
  `]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 400,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => fragment.text)).toEqual([
    "macOS / Linux",
    "$ curl -fsSL Copy",
  ]);
  expect(layout.fragments.map((fragment) => fragment.y)).toEqual([0, 26]);
  expect([...tree.nodesById.values()].find((node) => node.tagName === "BUTTON")?.type).toBe("inline-flex");
  window.happyDOM.abort();
});

test("keeps block box styles for direct flex-column block children", () => {
  const { document, window } = parseHTMLDocument(`<body><div class="hero">
    <h1>title</h1>
    <p>lede</p>
  </div></body>`);
  const styles = new StyleEngine().compute(document, [`
    .hero { display:flex; flex-direction:column; gap:4px }
    h1 { margin:0 0 10px } p { margin:0 }
  `]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 400,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => [fragment.text, fragment.y])).toEqual([
    ["title", 0],
    ["lede", 34],
  ]);
  window.happyDOM.abort();
});

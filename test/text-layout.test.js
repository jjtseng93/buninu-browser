import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

function boxFor(tree, layout, tagName) {
  return layout.boxes.find((box) => tree.nodesById.get(box.nodeId)?.tagName === tagName);
}

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
    "中文😀",
    "abcdef",
  ]);
  expect(layout.fragments.map((fragment) => fragment.y)).toEqual([8, 28, 48, 68]);
  expect(layout.fragments[0]).toMatchObject({
    id: `${tree.generation}:0`,
    type: "line",
    x: 4,
    width: 130,
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
  expect(boxFor(tree, layout, "DIV")).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
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
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });

  expect(boxFor(tree, layout, "DIV")).toMatchObject({ x: 50, width: 100 });
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

function layoutFixture(html, css = "", width = 400) {
  const parsed = parseHTMLDocument(`<body>${html}</body>`);
  const styles = new StyleEngine().compute(parsed.document, [css]);
  const tree = new RenderTreeBuilder().build(parsed.document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
    fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const box = (selector) => {
    const element = parsed.document.querySelector(selector);
    return layout.boxes.find((candidate) => tree.nodesById.get(candidate.nodeId)?.domNode === element);
  };
  return { ...parsed, tree, layout, box };
}

test("nests block boxes and includes ancestor padding and borders", () => {
  const { window, layout, box } = layoutFixture(
    `<section><div>text</div></section>`,
    `section { padding:10px; border:2px solid red } div { padding:5px }`,
  );

  expect(box("section")).toMatchObject({ x: 0, y: 0, width: 400, height: 54 });
  expect(box("div")).toMatchObject({ x: 12, y: 12, width: 376, height: 30 });
  expect(layout.fragments[0]).toMatchObject({ text: "text", x: 17, y: 17 });
  window.happyDOM.abort();
});

test("collapses adjacent sibling margins and parent-child margins", () => {
  const { window, layout, box } = layoutFixture(
    `<div class="a">a</div><div class="b">b</div><section><p>c</p></section>`,
    `.a { margin-bottom:30px } .b { margin-top:10px; margin-bottom:5px } section { margin-top:8px } p { margin:20px 0 }`,
  );

  expect(box(".a").y).toBe(0);
  expect(box(".b").y).toBe(50);
  // section has no border/padding, so its top margin collapses with p's 20px.
  expect(box("section")).toMatchObject({ y: 90, height: 20 });
  expect(layout.fragments.map((fragment) => fragment.y)).toEqual([0, 50, 90]);
  expect(layout.height).toBe(130);
  window.happyDOM.abort();
});

test("applies margin longhands in cascade order and border-box sizing", () => {
  const { window, box } = layoutFixture(
    `<div class="card">x</div>`,
    `* { box-sizing:border-box } .card { margin:4px; margin-left:30px; width:100px; padding:0 10px; border:1px solid red }`,
  );

  expect(box(".card")).toMatchObject({ x: 30, y: 4, width: 100 });
  window.happyDOM.abort();
});

test("shrink-wraps and centers flex-column items", () => {
  const { window, box } = layoutFixture(
    `<div class="column"><span class="item">abcd</span><p class="wide">x</p></div>`,
    `.column { display:flex; flex-direction:column; align-items:center } .wide { width:200px }`,
  );

  expect(box(".item")).toMatchObject({ x: 180, width: 40 });
  expect(box(".wide")).toMatchObject({ x: 100, width: 200 });
  window.happyDOM.abort();
});

test("lays out inline-block atoms on the line and paints decorated inline boxes", () => {
  const { window, layout, box } = layoutFixture(
    `before <code>npx</code> <button>go</button> after`,
    `code { padding:0 5px; background:#333 } button { padding:4px 6px; border:1px solid red }`,
  );
  const line = layout.fragments.find((fragment) => fragment.text.startsWith("before"));

  expect(line.text).toBe("before npx ￼ after");
  const codeRun = line.runs.find((run) => run.text === "npx");
  expect(codeRun.x).toBe(75);
  expect(box("code")).toMatchObject({ x: 70, width: 40, inline: true });
  const buttonRun = line.runs.find((run) => run.type === "atomic");
  expect(buttonRun).toMatchObject({ x: 120, width: 34 });
  expect(box("button")).toMatchObject({ x: 120, width: 34, height: 30 });
  expect(layout.fragments.find((fragment) => fragment.text === "go")).toMatchObject({ x: 127 });
  window.happyDOM.abort();
});

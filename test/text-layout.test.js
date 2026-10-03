import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { LayoutEngine, layoutText } from "../lib/layout/text-layout.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

function boxFor(tree, layout, tagName) {
  return layout.boxes.find((box) => tree.nodesById.get(box.nodeId)?.tagName === tagName);
}

test("creates positioned immutable line fragments with fixed-column wrapping", () => {
  const { document, window } = parseHTMLDocument(
    `<body style="margin:0">1234567890ABCDEFGHIJ<br>中文😀abcdef</body>`,
  );
  const tree = new RenderTreeBuilder().build(document);
  const layout = layoutText(tree, { columns: 10, x: 4, y: 8, lineHeight: 20 });

  expect(layout.generation).toBe(tree.generation);
  // A word wider than the line overflows it (overflow-wrap: normal).
  expect(layout.fragments.map((fragment) => fragment.text)).toEqual([
    "1234567890ABCDEFGHIJ",
    "中文😀",
    "abcdef",
  ]);
  expect(layout.fragments.map((fragment) => fragment.y)).toEqual([8, 28, 48]);
  expect(layout.fragments[0]).toMatchObject({
    id: `${tree.generation}:0`,
    type: "line",
    x: 4,
    width: 260,
    height: 20,
  });
  expect(layout.fragments[0].nodeIds.length).toBeGreaterThan(0);
  expect(Object.isFrozen(layout)).toBeTrue();
  expect(Object.isFrozen(layout.fragments)).toBeTrue();
  expect(Object.isFrozen(layout.fragments[0])).toBeTrue();
  window.happyDOM.abort();
});

test("uses block boundaries, collapses normal whitespace and preserves preformatted lines", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
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
  const { document, window } = parseHTMLDocument(`<body style="margin:0">before</body>`);
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
    `<body style="margin:0"><div style="margin:10px;padding:5px;width:40px">abcdef</div></body>`,
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

  // "abcdef" is wider than the 40px content box and overflows it.
  expect(layout.fragments.map((fragment) => fragment.text)).toEqual(["abcdef"]);
  expect(layout.fragments.map((fragment) => [fragment.x, fragment.y])).toEqual([[15, 15]]);
  expect(boxFor(tree, layout, "DIV")).toMatchObject({ x: 10, y: 10, width: 50, height: 30 });
  expect(layout.height).toBe(50);
  window.happyDOM.abort();
});

test("measures and positions inline runs with their own computed styles", () => {
  const { document, window } = parseHTMLDocument(
    `<body style="margin:0"><span style="color:red;font-size:30px">aa</span><strong>bb</strong></body>`,
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
    `<body style="margin:0"><div style="max-width:50%;margin:0 auto">centered</div></body>`,
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
  const { document, window } = parseHTMLDocument(`<body style="margin:0">before<img src="pixel.png" width="40">after</body>`);
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
  // line-height: normal; the image sits on the baseline, so the line adds the font descent below it.
  expect(layout.fragments[0].height).toBeCloseTo(20 + 16 * (1.17 - 0.93));
  window.happyDOM.abort();
});

test("lays out flex-row items as separate boxes with justify-content and gap", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
    <nav style="display:flex;justify-content:center;gap:20px"><div>one</div><div>two</div></nav>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });

  expect(layout.fragments.map((fragment) => [fragment.text, fragment.x, fragment.y])).toEqual([
    ["one", 60, 0],
    ["two", 110, 0],
  ]);
  window.happyDOM.abort();
});

test("wraps at word boundaries and breaks inside words only where overflow-wrap or word-break allow", () => {
  const texts = (style) => {
    const { document, window } = parseHTMLDocument(`<body style="margin:0;${style}">hello world abcdefghij</body>`);
    const layout = layoutText(new RenderTreeBuilder().build(document, new StyleEngine().compute(document)), {
      x: 0,
      y: 0,
      width: 70,
      measureText: (text) => text.length * 10,
    });
    window.happyDOM.abort();
    return layout.fragments.map((fragment) => fragment.text);
  };
  expect(texts("")).toEqual(["hello", "world", "abcdefghij"]);
  expect(texts("overflow-wrap:anywhere")).toEqual(["hello", "world", "abcdefg", "hij"]);
  expect(texts("word-wrap:break-word")).toEqual(["hello", "world", "abcdefg", "hij"]);
  expect(texts("word-break:break-all")).toEqual(["hello", "world", "abcdefg", "hij"]);
});

test("distributes remaining flex-row space between direct children", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
    <nav style="display:flex;justify-content:space-between;gap:10px"><span>left</span><span>right</span></nav>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0,
    y: 0,
    width: 200,
    measureText: (text) => text.length * 10,
  });
  const runs = layout.fragments.flatMap((fragment) => fragment.runs);

  expect(runs[0]).toMatchObject({ text: "left", x: 0, width: 40 });
  expect(runs.at(-1)).toMatchObject({ text: "right", x: 150, width: 50 });
  window.happyDOM.abort();
});

test("places direct flex-column children on separate lines with column gap", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0"><div class="prereq-command">
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

  // The button's spans are flex items of the inline-flex row, 8px apart,
  // inside the UA button padding (1px 6px) and 1px border.
  expect(layout.fragments.map((fragment) => [fragment.text, fragment.x, fragment.y])).toEqual([
    ["macOS / Linux", 0, 0],
    ["$", 7, 28],
    ["curl -fsSL", 25, 28],
    ["Copy", 133, 28],
  ]);
  expect([...tree.nodesById.values()].find((node) => node.tagName === "BUTTON")?.type).toBe("inline-flex");
  window.happyDOM.abort();
});

test("keeps block box styles for direct flex-column block children", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0"><div class="hero">
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
  const parsed = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
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

test("places outside list markers on the first line's baseline", () => {
  const { window, layout } = layoutFixture(
    `<ul><li>one</li><li><p>two</p></li></ul><ol start="3"><li>c</li><li value="9">d</li><li>e</li></ol><ul class="bare"><li>x</li></ul>`,
    `ul, ol { margin:0; padding-left:40px } p { margin:0 } .bare { list-style:none }`,
  );
  const markers = layout.fragments.flatMap((fragment) => fragment.runs).filter((run) => run.type === "marker");

  expect(markers.map((run) => run.text)).toEqual(["• ", "• ", "3. ", "9. ", "5. "]);
  // Marker end touches the content edge (x = 40); widths are 10px per character.
  expect(markers.map((run) => run.x)).toEqual([20, 20, 10, 10, 10]);
  const firstLine = layout.fragments.find((fragment) => fragment.text === "one");
  const firstMarker = layout.fragments.find((fragment) => fragment.runs[0]?.type === "marker");
  expect(firstMarker.baseline).toBe(firstLine.baseline);
  window.happyDOM.abort();
});

test("floats line up left to right, right floats at the line end; flex items do not float", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
    <ul style="list-style:none;margin:0;padding:0"><li style="float:left">Fork</li><li style="float:left">Star</li><li style="float:right">Right</li></ul>
    <div style="display:flex"><span style="float:left">item</span></div></body>`);
  const styles = new StyleEngine().compute(document);
  const layout = layoutText(new RenderTreeBuilder().build(document, styles), {
    x: 0, y: 0, width: 300, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const placed = layout.fragments.flatMap((fragment) => fragment.runs.filter((run) => run.text?.trim()))
    .map((run) => [run.text, Math.round(run.x), run.y]);
  expect(placed).toEqual([["Fork", 0, 0], ["Star", 40, 0], ["Right", 250, 0], ["item", 0, 20]]);
  expect(styles.get(document.querySelector("span")).float).toBe("none");
  window.happyDOM.abort();
});

function layoutOf(html, width = 400) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0, y: 0, width, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  window.happyDOM.abort();
  const runs = layout.fragments.flatMap((fragment) => fragment.runs.filter((run) => run.text?.trim()));
  return { layout, runs, at: (text) => runs.find((run) => run.text === text) };
}

test("tables size columns from their contents, span columns and center cells vertically", () => {
  const { at } = layoutOf(`<table style="border-spacing:0">
    <thead><tr><th>Name</th><th>Message</th></tr></thead>
    <tbody><tr><td>bin</td><td>Windows compatibility</td></tr><tr><td style="height:60px">x</td><td>mid</td></tr>
    <tr><td colspan="2">wide cell here</td></tr></tbody></table>`);
  // Column 1 is as wide as "Name" (+1px padding each side), column 2 as the longest message.
  expect(at("Name")).toMatchObject({ x: 1, y: 1 });
  expect(at("bin").x).toBe(1);
  expect(at("Windows compatibility").x).toBe(43);
  // th is centered in column 2's 210px content box (from x 43): 43 + (210 - 70) / 2.
  expect(Math.round(at("Message").x)).toBe(113);
  // A 60px-tall row centres its other cells.
  expect(at("mid").y).toBe(at("x").y + 20);
  expect(at("wide cell here").x).toBe(1);
});

test("table-layout: fixed ignores contents; text-overflow: ellipsis truncates; nowrap never breaks words", () => {
  const { at } = layoutOf(`<table style="table-layout:fixed;width:200px;border-spacing:0">
    <tr><td style="width:50px;padding:0">a</td><td style="padding:0">averyveryverylongword</td></tr></table>`);
  expect(at("averyveryverylongword").x).toBe(50);
  const { runs } = layoutOf(`<div style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:anywhere">abcdefghijkl</div>`);
  expect(runs.map((run) => [run.text, run.x])).toEqual([["abcdefg", 0], ["…", 70]]);
});

test("an auto grid track is limited by a min-width: 0 item instead of its content", () => {
  const { layout, at } = layoutOf(`<div style="display:grid;width:100px"><div style="min-width:0;white-space:nowrap;overflow:hidden">abcdefghijklmnop</div></div>`);
  expect(at("abcdefghijklmnop").x).toBe(0);
  // The item (second box) is 100px wide, not its 160px content.
  expect(layout.boxes.map((box) => box.width)).toContain(100);
  expect(layout.boxes.map((box) => box.width)).not.toContain(160);
});

test("a grid body stacks items sharing an area and aligns its content with place-*", () => {
  const { document, window } = parseHTMLDocument(`<body><i id="icon" style="display:block;width:40px;height:40px"></i>
    <p id="a">one</p><p id="b">two two</p><p id="c">three</p></body>`);
  const styles = new StyleEngine().compute(document, [`
    body { margin:0; display:grid; min-height:300px; place-content:center; place-items:center }
    p { margin:0; grid-area:2/1 }
  `]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0, y: 0, width: 400, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const boxOf = (id) => layout.boxes.find((box) => tree.nodesById.get(box.nodeId)?.domNode?.id === id);
  const [icon, a, b, c] = ["icon", "a", "b", "c"].map(boxOf);
  // One shared row for the paragraphs, centered in 300px under the 40px icon row.
  expect([a.y, b.y, c.y]).toEqual([a.y, a.y, a.y]);
  expect(icon.y).toBe((300 - 40 - 20) / 2);
  expect(a.y).toBe(icon.y + 40);
  // place-items: center centers each item in the 70px-wide column ("two two").
  expect([icon.x, a.x, b.x]).toEqual([180, 185, 165]);
  window.happyDOM.abort();
});

test("retained block results match a clean layout after a sibling changes", () => {
  const { document, window } = parseHTMLDocument(`<body><section><p>unchanged subtree</p></section><section id="edit">short</section></body>`);
  const styles = new StyleEngine().compute(document);
  const builder = new RenderTreeBuilder();
  const engine = new LayoutEngine({
    measureText: (text) => text.length * 10,
    fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const options = { x: 0, y: 0, width: 240, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }) };
  engine.layout(builder.build(document, styles), options);

  document.getElementById("edit").textContent = "a changed sibling which wraps onto another line";
  const tree = builder.build(document, styles);
  const retained = engine.layout(tree, options);
  const clean = layoutText(tree, options);
  expect(retained).toEqual(clean);
  window.happyDOM.abort();
});

/** A layout with paint layers as ranks: replays renumber layers, keeping their order. */
function rankedLayout(layout) {
  const orders = new Set([0]);
  for (const entry of [...layout.boxes, ...layout.fragments]) {
    for (let layer = entry.layer; layer; layer = layer.parent) orders.add(layer.order);
  }
  const rank = new Map([...orders].sort((a, b) => a - b).map((order, index) => [order, index]));
  const layer = (value) => value && { rank: rank.get(value.order), z: value.z, context: value.context, parent: value.parent ? rank.get(value.parent.order) : null };
  return {
    height: layout.height,
    boxes: layout.boxes.map((box) => ({ ...box, layer: layer(box.layer) })),
    fragments: layout.fragments.map(({ id, ...fragment }) => ({ ...fragment, layer: layer(fragment.layer) })),
  };
}

function retainedAndClean(html, change) {
  const { document, window } = parseHTMLDocument(html);
  const styles = new StyleEngine().compute(document);
  const builder = new RenderTreeBuilder();
  const measure = { measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }) };
  const engine = new LayoutEngine(measure);
  const options = { x: 0, y: 0, width: 240, viewportHeight: 300, ...measure };
  engine.layout(builder.build(document, styles), options);
  change(document);
  const tree = builder.build(document, styles);
  const result = { retained: engine.layout(tree, options), clean: layoutText(tree, options), document };
  window.happyDOM.abort();
  return result;
}

test("positioned boxes inside a retained block are replayed in their paint layers", () => {
  const { retained, clean } = retainedAndClean(`<body><p id="edit">short</p>
    <section><div style="position:relative;z-index:2">raised <span style="position:relative">inner</span></div>
    <div style="position:relative">auto</div><p style="position:absolute;top:5px;z-index:-1">behind</p></section></body>`,
  (document) => { document.getElementById("edit").textContent = "a longer paragraph that wraps onto two lines"; });
  expect(rankedLayout(retained)).toEqual(rankedLayout(clean));
  // The section moved down with the wrapped paragraph, and its layers came along.
  expect(new Set(retained.boxes.map((box) => box.layer.order)).size).toBe(new Set(clean.boxes.map((box) => box.layer.order)).size);
});

test("an out-of-flow box keeps its static position when the block around its placeholder is replayed", () => {
  // The absolute box's containing block is the positioned div; its placeholder is in the section,
  // which is replayed (moved down) after the paragraph above it grows.
  const { retained, clean } = retainedAndClean(`<body><div style="position:relative"><p id="edit">short</p>
    <section><p>above</p><div style="position:absolute">static</div><p>below</p></section></div></body>`,
  (document) => { document.getElementById("edit").textContent = "a longer paragraph that wraps onto two lines"; });
  expect(rankedLayout(retained)).toEqual(rankedLayout(clean));
});

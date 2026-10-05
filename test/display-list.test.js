import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { buildDisplayList, hitTarget, visibleItems } from "../lib/paint/display-list.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

function displayListFor(html, css, resources = new WeakMap()) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document, [css]);
  const tree = new RenderTreeBuilder().build(document, styles, resources);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 200,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
    fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  return { document, window, tree, displayList: buildDisplayList(layout, tree) };
}

test("paints box decorations in tree order before inline content", () => {
  const { window, displayList } = displayListFor(
    `<div class="card"><p>hi <code>x</code></p></div>`,
    `.card { background:#111; border:2px solid #f00; border-radius:6px; padding:4px }
     p { margin:0; color:#0f0 } code { background:#333 }`,
  );

  expect(displayList.items.map((item) => item.op)).toEqual([
    "fillRect", "border", "fillRect", "drawText", "drawText",
  ]);
  const [background, border, code, text] = displayList.items;
  expect(background).toMatchObject({ rect: { x: 0, y: 0, width: 200, height: 32 }, radii: { x: 6, y: 6 }, color: "rgba(17, 17, 17, 1)" });
  expect(border).toMatchObject({ rect: { x: 0, y: 0, width: 200, height: 32 }, widths: [2, 2, 2, 2] });
  expect(border.colors).toEqual(Array(4).fill("rgba(255, 0, 0, 1)"));
  expect(code).toMatchObject({ rect: { x: 36, width: 10 } });
  expect(text).toMatchObject({ text: "hi ", x: 6, font: { size: 16, weight: 400 }, color: "rgba(0, 255, 0, 1)" });
  expect(Object.isFrozen(displayList.items[0].rect)).toBeTrue();
  window.happyDOM.abort();
});

test("serializes without image resources and culls by bounds", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0"><img src="a.png" width="20" height="10"><div style="height:500px"></div><p>far</p></body>`);
  const image = document.querySelector("img");
  const resource = { width: 20, height: 10, image: { canvasKitImage: true } };
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles, new WeakMap([[image, resource]]));
  const displayList = buildDisplayList(layoutText(tree, {
    x: 0, y: 0, width: 200, measureText: (text) => text.length * 10,
  }));

  const draw = displayList.items.find((item) => item.op === "drawImage");
  expect(displayList.images[draw.image]).toBe(resource);
  expect(JSON.stringify(displayList)).not.toContain("canvasKitImage");
  expect(visibleItems(displayList, { x: 0, y: 0, width: 200, height: 100 }).map((item) => item.op)).toEqual(["drawImage"]);
  expect(visibleItems(displayList, { x: 0, y: 500, width: 200, height: 100 }).map((item) => item.text)).toEqual(["far"]);
  window.happyDOM.abort();
});

test("emits box shadows, gradient layers, rounded images and gradient text", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">
    <div class="hero"><img class="logo" src="a.png" width="40" height="40"><h1 class="slogan">Hi</h1></div></body>`);
  const image = document.querySelector("img");
  const resource = { width: 40, height: 40, image: {} };
  const styles = new StyleEngine().compute(document, [`
    .hero { background: radial-gradient(100px 50px at 50% 0%, red, transparent 60%), linear-gradient(180deg, #111, #222) }
    .logo { display:block; border-radius:8px; box-shadow: 0 20px 60px #ffb70340 }
    .slogan { margin:0; background: linear-gradient(90deg, #ffb703, #ff6b6b); -webkit-background-clip:text; background-clip:text; color:transparent }
  `]);
  const tree = new RenderTreeBuilder().build(document, styles, new WeakMap([[image, resource]]));
  const displayList = buildDisplayList(layoutText(tree, {
    x: 0, y: 0, width: 200, measureText: (text) => text.length * 10,
  }));
  const ops = displayList.items.map((item) => item.op + (item.gradient ? `:${item.gradient.type}` : ""));

  // Background layers paint bottom-up; the clipped-text gradient is not a box fill.
  expect(ops).toEqual(["fillRect:linear", "fillRect:radial", "drawShadow", "drawImage", "drawText:linear"]);
  const shadow = displayList.items.find((item) => item.op === "drawShadow");
  expect(shadow).toMatchObject({ rect: { x: 0, y: 20, width: 40, height: 40 }, blur: 60, radii: { x: 8, y: 8 }, clip: { y: 0 } });
  expect(shadow.color).toBe("rgba(255, 183, 3, 0.2509804)");
  expect(displayList.items.find((item) => item.op === "drawImage").radii).toEqual({ x: 8, y: 8 });
  const text = displayList.items.find((item) => item.op === "drawText");
  expect(text.gradient.stops.map((stop) => stop.color)).toEqual(["rgba(255, 183, 3, 1)", "rgba(255, 107, 107, 1)"]);
  window.happyDOM.abort();
});

test("resolves percentage radii per axis and scales overlapping radii down", () => {
  const { window, displayList } = displayListFor(
    `<div class="pill">x</div><div class="huge">y</div>`,
    `.pill { width:100px; height:40px; background:#111; border-radius:50% }
     .huge { width:100px; height:40px; background:#222; border-radius:60px }`,
  );
  const [pill, huge] = displayList.items.filter((item) => item.op === "fillRect");
  expect(pill.radii).toEqual({ x: 50, y: 20 });
  // 60px corners would overlap on a 40px-tall box: scale by 40 / 120.
  expect(huge.radii.x).toBeCloseTo(20);
  expect(huge.radii.y).toBeCloseTo(20);
  window.happyDOM.abort();
});

test("visibility, opacity and overflow/clip clipping apply to descendants", () => {
  const { window, displayList } = displayListFor(`
    <div id="hidden" style="visibility:hidden"><span>gone</span><b style="visibility:visible">shown</b></div>
    <div style="opacity:0"><p>invisible</p></div>
    <div style="opacity:0.5"><p style="opacity:0.5">faint</p></div>
    <div style="overflow:hidden;width:30px;height:20px;white-space:nowrap"><p style="margin:0">clipped</p><p style="margin:0">below</p></div>
    <div style="position:relative"><div style="overflow:hidden;height:5px"><p style="position:absolute">escapes</p></div></div>
    <p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">screen reader only</p>
    <p style="clip-path:inset(50%)">also sr-only</p>`, "");
  const texts = displayList.items.filter((item) => item.op === "drawText");
  const byText = (text) => texts.find((item) => item.text.includes(text));
  expect(byText("gone")).toBeUndefined();
  expect(byText("shown")).toBeDefined();
  expect(byText("invisible")).toBeUndefined();
  expect(byText("faint").opacity).toBeCloseTo(0.25);
  expect(byText("clipped").clipRect).toMatchObject({ width: 30, height: 20 });
  expect(byText("clipped").bounds.width).toBe(30);
  // Entirely outside the clip: not in the list at all.
  expect(byText("below")).toBeUndefined();
  // An absolutely positioned box is not clipped by a non-positioned ancestor
  // between it and its containing block.
  expect(byText("escapes").clipRect ?? null).toBeNull();
  expect(byText("screen reader only")).toBeUndefined();
  expect(byText("also sr-only")).toBeUndefined();
  window.happyDOM.abort();
});


function backgroundList(html, css, resources) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document, [css]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0, y: 0, width: 200, lineHeight: 20, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const displayList = buildDisplayList(layout, tree, null, (url) => resources[url] ?? null);
  window.happyDOM.abort();
  return displayList;
}

test("background images are sized, positioned and repeated in the padding box, painted in the border box", () => {
  const icon = { width: 48, height: 24, image: {} };
  const items = backgroundList(
    `<div class="a"></div><div class="b"></div><div class="c"></div><div class="missing"></div>`,
    `div { height:60px; width:100px }
     .a { background: url(icon.png) no-repeat center / 32px; border: 2px solid black }
     .b { background-image: url(icon.png); background-size: cover; background-repeat: repeat-x }
     .c { background: url(icon.png) no-repeat right 5px bottom 10px }
     .missing { background: url(none.png) }`,
    { "icon.png": icon },
  ).items.filter((item) => item.op === "drawBackgroundImage");
  // The image that has not arrived paints nothing.
  expect(items).toHaveLength(3);
  const [a, b, c] = items;
  // 32px wide keeps the 2:1 ratio, centered in the 100x60 padding box inside the border.
  expect(a).toMatchObject({ tile: { x: 2 + 34, y: 2 + 22, width: 32, height: 16 }, repeatX: false, repeatY: false });
  expect(a.bounds).toEqual({ x: 36, y: 24, width: 32, height: 16 });
  // cover: scaled to fill both sides; repeat-x spans the box horizontally only.
  expect(b).toMatchObject({ tile: { x: 0, y: 64, width: 120, height: 60 }, repeatX: true, repeatY: false });
  expect(b.bounds).toEqual({ x: 0, y: 64, width: 100, height: 60 });
  // Edge offsets: 5px from the right, 10px from the bottom.
  expect(c.tile).toEqual({ x: 100 - 5 - 48, y: 124 + 60 - 10 - 24, width: 48, height: 24 });
});

test("transform: scale paints and hit-tests a box and its contents about its origin", () => {
  const displayList = backgroundList(
    `<div class="tile"><span>x</span></div>`,
    `.tile { width:100px; height:100px; background:#123; transform: scale(.5); overflow: hidden }`,
    {},
  );
  const fill = displayList.items.find((item) => item.op === "fillRect");
  expect(fill.transform).toEqual({ a: 0.5, d: 0.5, e: 25, f: 25 });
  expect(fill.bounds).toEqual({ x: 25, y: 25, width: 50, height: 50 });
  // Its overflow clip shrinks with it.
  const text = displayList.items.find((item) => item.op === "drawText");
  expect(text.clipRect).toEqual({ x: 25, y: 25, width: 50, height: 50 });
  expect(hitTarget(displayList, 10, 10, { x: 0, y: 0 })).not.toBe(fill.nodeId);
  expect(hitTarget(displayList, 30, 30, { x: 0, y: 0 })).toBe(fill.nodeId);
});

test("a scroll container moves its content by its scroll offset and reports how far the content reaches", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0"><div id="box"><p>a</p><p>b</p><p>c</p></div></body>`);
  const styles = new StyleEngine().compute(document, [`#box { height:40px; overflow:auto; background:#123 } p { margin:0; height:20px }`]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0, y: 0, width: 200, lineHeight: 20, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const box = document.getElementById("box");
  const displayList = buildDisplayList(layout, tree, null, null, (element) => element === box ? { x: 0, y: 15 } : null);
  window.happyDOM.abort();
  const background = displayList.items.find((item) => item.op === "fillRect");
  // The container itself stays; its text moves up by the offset, clipped to it.
  expect(background.transform).toBeUndefined();
  const second = displayList.items.find((item) => item.op === "drawText" && item.text === "b");
  expect(second.transform).toEqual({ a: 1, d: 1, e: 0, f: -15 });
  expect(second.clipRect).toEqual({ x: 0, y: 0, width: 200, height: 40 });
  const boxId = [...tree.nodesById.values()].find((node) => node.domNode === box).id;
  expect(displayList.scrollers.get(boxId)).toMatchObject({ bottom: 60 });
  expect(hitTarget(displayList, 5, 10, { x: 0, y: 0 })).toBe(second.nodeId);
});

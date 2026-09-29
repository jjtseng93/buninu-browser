import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { buildDisplayList, visibleItems } from "../lib/paint/display-list.js";
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


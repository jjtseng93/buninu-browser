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
  return { document, window, tree, displayList: buildDisplayList(layout) };
}

test("paints box decorations in tree order before inline content", () => {
  const { window, displayList } = displayListFor(
    `<div class="card"><p>hi <code>x</code></p></div>`,
    `.card { background:#111; border:2px solid #f00; border-radius:6px; padding:4px }
     p { margin:0; color:#0f0 } code { background:#333 }`,
  );

  expect(displayList.items.map((item) => item.op)).toEqual([
    "fillRect", "strokeRect", "fillRect", "drawText", "drawText",
  ]);
  const [background, border, code, text] = displayList.items;
  expect(background).toMatchObject({ rect: { x: 0, y: 0, width: 200, height: 32 }, radius: 6, color: "rgba(17, 17, 17, 1)" });
  expect(border.rect).toEqual({ x: 1, y: 1, width: 198, height: 30 });
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

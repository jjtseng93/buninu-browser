import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { buildDisplayList } from "../lib/paint/display-list.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";

function render(html, css) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0">${html}</body>`);
  const styles = new StyleEngine().compute(document, [css]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0,
    y: 0,
    width: 400,
    viewportHeight: 300,
    lineHeight: 20,
    measureText: (text) => text.length * 10,
    fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const box = (selector, pseudo = null) => {
    const element = document.querySelector(selector);
    const found = layout.boxes.find((candidate) => {
      const node = tree.nodesById.get(candidate.nodeId);
      return node?.domNode === element && (node.pseudo ?? null) === pseudo;
    });
    return found && { x: found.x, y: found.y, width: found.width, height: found.height };
  };
  // The first line run of an element (an image) or of its text.
  const run = (selector) => {
    const element = document.querySelector(selector);
    for (const fragment of layout.fragments) {
      for (const candidate of fragment.runs) {
        const node = tree.nodesById.get(candidate.nodeId)?.domNode;
        if (node === element || node?.parentElement === element) {
          return { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height };
        }
      }
    }
    return null;
  };
  window.happyDOM.abort();
  return { layout, tree, box, run };
}

test("absolute boxes leave the flow and resolve insets against the positioned ancestor's padding box", () => {
  const { box } = render(
    `<div class="card"><p>one</p><span class="badge">!</span><p>two</p></div>`,
    `.card { position:relative; margin:10px; padding:5px; border:2px solid red; height:100px }
     p { margin:0 }
     .badge { position:absolute; top:4px; right:6px; width:30px; height:12px }`,
  );
  // The second paragraph follows the first directly: the badge takes no space.
  expect(box("p:last-of-type").y).toBe(10 + 2 + 5 + 20);
  // Padding box: x 12..388 (card 10..390 minus border), y 12.
  expect(box(".badge")).toEqual({ x: 388 - 6 - 30, y: 12 + 4, width: 30, height: 12 });
});

test("left+right and top+bottom stretch an absolute box, percentages use the containing block", () => {
  const { box } = render(
    `<div class="frame"><div class="fill"></div><div class="half"></div></div>`,
    `.frame { position:relative; width:200px; height:100px }
     .fill { position:absolute; inset:10px 20px }
     .half { position:absolute; top:50%; left:25%; width:10px; height:10px }`,
  );
  expect(box(".fill")).toEqual({ x: 20, y: 10, width: 160, height: 80 });
  expect(box(".half")).toMatchObject({ x: 50, y: 50 });
});

test("absolute percentage width uses the full containing block after a left inset", () => {
  const { box } = render(
    `<div class="frame"><div class="first"></div><div class="second"></div></div>`,
    `.frame { position:relative; width:200px; height:100px }
     .first, .second { position:absolute; top:0; width:10%; height:20px }
     .first { left:10% } .second { left:70% }`,
  );
  expect(box(".first")).toEqual({ x: 20, y: 0, width: 20, height: 20 });
  expect(box(".second")).toEqual({ x: 140, y: 0, width: 20, height: 20 });
});

test("relative offsets and translate move a box and its content without affecting siblings", () => {
  const { box, layout } = render(
    `<div class="moved">text</div><div class="next">after</div><div class="centered"></div>`,
    `.moved { position:relative; top:5px; left:7px }
     .centered { width:40px; height:20px; transform: translate(-50%, 50%) }`,
  );
  expect(box(".moved")).toMatchObject({ x: 7, y: 5 });
  expect(layout.fragments.find((fragment) => fragment.text === "text")).toMatchObject({ x: 7, y: 5 });
  expect(box(".next").y).toBe(20);
  expect(box(".centered")).toMatchObject({ x: -20, y: 40 + 10 });
});

test("an absolutely positioned ::after arrow is centred on its host's edge", () => {
  // The buninu.org step arrow: top:50%; right:-.75rem; translate(50%,-50%).
  const { box } = render(
    `<ol><li class="step">one</li><li class="step">two</li></ol>`,
    `ol { margin:0; padding:0; list-style:none }
     .step { position:relative; height:100px; width:200px }
     .step:not(:last-child)::after { content:"\\2192"; position:absolute; top:50%; right:-12px;
       transform:translate(50%,-50%); width:28px; height:28px; display:flex; box-sizing:border-box }`,
  );
  const arrow = box(".step", "after");
  // Right edge at 200 + 12 = 212, then shifted right by half its width and up by half its height.
  expect(arrow).toEqual({ x: 212 - 28 + 14, y: 50 - 14, width: 28, height: 28 });
});

test("positioned boxes paint after in-flow content, ordered by z-index", () => {
  const { layout } = render(
    `<div class="a">A</div><div class="b">B</div><div class="c">C</div>`,
    `.a { position:relative; z-index:2; background:#111 }
     .b { background:#222 }
     .c { position:absolute; top:0; background:#333; z-index:-1 }`,
  );
  const colors = buildDisplayList(layout).items.filter((item) => item.op === "fillRect").map((item) => item.color);
  expect(colors).toEqual(["rgba(51, 51, 51, 1)", "rgba(34, 34, 34, 1)", "rgba(17, 17, 17, 1)"]);
});

test("a z-index stacking context paints its auto-positioned descendants after its own background", () => {
  const { layout } = render(
    `<header class="h"><nav class="n"><span class="t">Platform</span></nav></header><div class="later">L</div>`,
    `.h { position:relative; z-index:32; background:#000 }
     .n { position:relative; background:#111 }
     .later { position:relative; background:#222 }`,
  );
  const items = buildDisplayList(layout).items;
  const index = (predicate) => items.findIndex(predicate);
  const header = index((item) => item.op === "fillRect" && item.color === "rgba(0, 0, 0, 1)");
  const nav = index((item) => item.op === "fillRect" && item.color === "rgba(17, 17, 17, 1)");
  const text = index((item) => item.op === "drawText" && item.text === "Platform");
  const later = index((item) => item.op === "fillRect" && item.color === "rgba(34, 34, 34, 1)");
  // Inside the z-index 32 context: header background, then nav, then text.
  expect(header).toBeLessThan(nav);
  expect(nav).toBeLessThan(text);
  // The z-index auto sibling (z 0) paints before the z 32 context.
  expect(later).toBeLessThan(header);
});

test("relative offsets resolve percentages against the containing block, for blocks and inline boxes", () => {
  const { box, run } = render(
    `<div class="frame"><div class="moved"></div><p><span class="up">text</span> <img class="tile" width="20" height="20"></p></div>`,
    `.frame { width:200px; height:100px }
     .moved { position:relative; left:-25%; top:10%; height:10px }
     p { margin:0 }
     .up { position:relative; left:-10px; top:-5px }
     .tile { position:relative; left:-100%; top:0% }`,
  );
  // Percentages of the 200x100 containing block.
  expect(box(".moved")).toMatchObject({ x: -50, y: 10 });
  // The span's text moves with it; the image by a whole containing-block width.
  expect(run(".up")).toMatchObject({ x: -10 });
  expect(run(".tile").x).toBe(50 - 200);
});

test("an inline image sized in percentages takes its line space from the containing block", () => {
  const { run } = render(
    `<div class="wrapper"><img class="big"></div>`,
    `.wrapper { width:100px; height:100px; text-align:center; overflow:hidden }
     .big { width:300%; height:300% }`,
  );
  // 300px wide: the line overflows, so it starts at the left instead of being centered.
  expect(run(".big")).toMatchObject({ x: 0, width: 300, height: 300 });
});

test("a float shrinks to fit its contents' min-width and sits at the top of its line", () => {
  const { box } = render(
    `<div class="footer"><div class="left"></div><div class="right"><span class="button">Go</span></div></div>`,
    `.footer { width:300px; height:60px }
     .left { float:left; width:50px; height:48px; margin:6px }
     .right { float:right; margin:8px }
     .button { display:inline-block; min-width:100px; padding:0 10px; height:40px }`,
  );
  // min-width 100 plus padding: 120 wide, against the right edge less its margin.
  expect(box(".right")).toMatchObject({ x: 300 - 8 - 120, y: 8, width: 120 });
  expect(box(".left")).toMatchObject({ x: 6, y: 6 });
});

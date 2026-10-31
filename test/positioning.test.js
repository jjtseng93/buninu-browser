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

test("a percentage height fills a containing block whose height is definite", () => {
  const { box } = render(
    `<div class="frame"><div class="mid"><div class="fill"></div></div></div>`,
    `.frame { height:200px } .mid { height:50% } .fill { height:100%; background:black }`,
  );
  expect(box(".mid").height).toBe(100);
  expect(box(".fill").height).toBe(100);
});

test("a percentage height of an auto-sized parent stays the content height", () => {
  const { box } = render(
    `<div class="frame"><div class="fill">x</div></div>`,
    `.fill { height:100% }`,
  );
  expect(box(".fill").height).toBe(20);
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

test("transform lists compose pixel and percentage translations in order", () => {
  const { box } = render(
    `<div class="popup"></div><div class="scaled"></div><div class="reversed"></div><div class="math"></div>`,
    `.popup,.scaled,.reversed,.math { position:absolute;left:0;top:0;width:100px;height:153px }
     .popup { transform:translate(56px,780px) translate(0,-100%) }
     .scaled { transform:scale(2,3) translate(10px,20%) translateX(5px) }
     .reversed { transform:translate(10px,20%) scale(2,3) translateX(5px) }
     .math { transform:translate(calc(25% + 10px),min(20%,40px)) translate(10%,5px) }`,
  );
  expect(box(".popup")).toEqual({x:56,y:627,width:100,height:153});
  expect(box(".scaled")).toMatchObject({x:30,y:91.8});
  expect(box(".reversed")).toMatchObject({x:20,y:30.6});
  expect(box(".math")).toMatchObject({x:45,y:35.6});
});

test("individual translate precedes the transform list and preserves normal flow", () => {
  const {box} = render('<div class="translated"></div><div class="next"></div>',
    '.translated{width:100px;height:80px;translate:10px -50%;transform:scale(2) translate(5px,10px)}.next{height:20px}');
  expect(box('.translated')).toEqual({x:20,y:-20,width:100,height:80});
  expect(box('.next').y).toBe(80);
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

test("a column flex item with a main-axis auto margin is still centered across", () => {
  const { box } = render(
    `<div class="column"><div class="item"></div></div>`,
    `.column { display:flex; flex-direction:column; align-items:center; width:400px }
     .item { margin-top:auto; width:100px; height:20px }`,
  );
  expect(box(".item")).toMatchObject({ x: 150, width: 100 });
});

test("an svg without width and height fills its container and keeps its viewBox's ratio", () => {
  const { run } = render(
    `<div class="icon"><svg id="plain" viewBox="0 -960 960 960"><path d="M0 0h10v10z"/></svg></div>
     <div class="icon"><svg id="lower" viewbox="0 0 24 12"></svg></div>
     <div class="icon"><svg id="sized" width="10" height="5" viewBox="0 0 24 24"></svg></div>
     <div class="icon"><svg id="bare"></svg></div>`,
    `.icon { width:24px }`,
  );
  // 100% of the 24px container; height by the viewBox (a lowercase viewbox too).
  expect(run("#plain")).toMatchObject({ width: 24, height: 24 });
  expect(run("#lower")).toMatchObject({ width: 24, height: 12 });
  // Its own attributes win; with nothing at all it is 150px high.
  expect(run("#sized")).toMatchObject({ width: 10, height: 5 });
  expect(run("#bare")).toMatchObject({ width: 24, height: 150 });
});

test("aspect-ratio sizes bottom-anchored controls and centers a percentage-width grid child", () => {
  const { box } = render(`<div class="stage"><div class="pad"><div class="knob"></div></div><button class="fire">!</button></div>`,
    `* { box-sizing:border-box } .stage { position:relative; width:400px; height:300px }
     .pad { position:absolute; left:20px; bottom:20px; width:150px; aspect-ratio:1; border:2px solid; display:grid; place-items:center }
     .knob { width:42%; aspect-ratio:1 }
     .fire { position:absolute; right:20px; bottom:20px; width:100px; aspect-ratio:1; border:2px solid; padding:4px }`);
  expect(box('.pad')).toEqual({ x:20, y:130, width:150, height:150 });
  expect(box('.knob').width).toBeCloseTo(61.32);
  expect(box('.knob').height).toBeCloseTo(61.32);
  expect(box('.knob').x).toBeCloseTo(64.34);
  expect(box('.knob').y).toBeCloseTo(174.34);
  expect(box('.fire')).toEqual({ x:280, y:180, width:100, height:100 });
});

test("aspect-ratio respects box-sizing, definite dimensions and height constraints", () => {
  const { box } = render(`<div id="content"></div><div id="border"></div><div id="height"></div>
    <div id="both"></div><div id="clamped"><div id="percent"></div></div>`,
    `#content,#border { width:100px; aspect-ratio:2; padding:10px; border:2px solid }
     #border { box-sizing:border-box }
     #height { height:40px; aspect-ratio:2 }
     #both { width:100px; height:30px; aspect-ratio:1 }
     #clamped { width:100px; aspect-ratio:1; max-height:40px }
     #percent { height:50% }`);
  expect(box('#content')).toMatchObject({ width:124, height:74 });
  expect(box('#border')).toMatchObject({ width:100, height:50 });
  expect(box('#height')).toMatchObject({ width:80, height:40 });
  expect(box('#both')).toMatchObject({ width:100, height:30 });
  expect(box('#clamped').height).toBe(40);
  expect(box('#percent').height).toBe(20);
});

test("grid normal alignment preserves an item's preferred ratio while explicit stretch can override it", () => {
  const { box } = render(`<div class="grid"><div id="normal"></div></div><div class="grid"><div id="stretch"></div></div>`,
    `.grid { display:grid; width:100px; height:200px } .grid>div { width:100px; aspect-ratio:1 }
     #stretch { align-self:stretch }`);
  expect(box('#normal')).toMatchObject({ width:100, height:100 });
  expect(box('#stretch')).toMatchObject({ width:100, height:200 });
});

test("aspect-ratio preserves the automatic content minimum unless min-height allows overflow", () => {
  const { box } = render(`<div class="ratio" id="auto"><div></div></div><div class="ratio" id="zero"><div></div></div>`,
    `.ratio { width:100px; aspect-ratio:2 } .ratio>div { height:80px } #zero { min-height:0 }`);
  expect(box('#auto').height).toBe(80);
  expect(box('#zero').height).toBe(50);
});

test("replaced elements use an explicit aspect-ratio or their natural ratio with auto", () => {
  const { box } = render(`<canvas id="override" width="200" height="100"></canvas>
    <canvas id="natural" width="200" height="100"></canvas><canvas id="degenerate" width="200" height="100"></canvas>`,
    `canvas { display:block; width:80px } #override { aspect-ratio:1 } #natural { aspect-ratio:auto 1 } #degenerate { aspect-ratio:0 / 1 }`);
  expect(box('#override')).toMatchObject({ width:80, height:80 });
  expect(box('#natural')).toMatchObject({ width:80, height:40 });
  expect(box('#degenerate')).toMatchObject({ width:80, height:40 });
});

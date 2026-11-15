import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { operatorCategory, mathLength } from "../lib/layout/mathml.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { StyleEngine } from "../lib/style/computed-style.js";
import { buildDisplayList } from "../lib/paint/display-list.js";

test('MathML token text respects its own visual effects and restored visibility', () => {
  const { document, window } = parseHTMLDocument(`<body><math><mi id="token">secret</mi><mi>visible</mi></math></body>`);
  const builder = new RenderTreeBuilder();
  const token = document.getElementById('token');
  const paint = () => {
    const tree = builder.build(document, new StyleEngine().compute(document));
    return buildDisplayList(layoutText(tree, {width:400}), tree);
  };
  try {
    for (const css of ['opacity:0', 'visibility:hidden']) {
      token.setAttribute('style', css);
      expect(paint().items.filter(item => item.op === 'drawText').map(item => item.text)).toEqual(['visible']);
      token.removeAttribute('style');
      expect(paint().items.filter(item => item.op === 'drawText').map(item => item.text)).toEqual(['secret', 'visible']);
    }
    token.setAttribute('style', 'opacity:0.5');
    expect(paint().items.find(item => item.text === 'secret').opacity).toBe(0.5);
    // An ancestor can hide the whole formula as an accessibility-only copy.
    document.querySelector('math').setAttribute('style', 'opacity:0');
    expect(paint().items.filter(item => item.op === 'drawText')).toEqual([]);
  } finally { window.happyDOM.close(); }
});

// 18px text, 10px per character, so 1em = 18px and one math unit (1/18em) = 1px.
function layoutMath(markup, width = 400) {
  const { document, window } = parseHTMLDocument(`<body style="margin:0;font-size:18px">${markup}</body>`);
  const tree = new RenderTreeBuilder().build(document, new StyleEngine().compute(document));
  const layout = layoutText(tree, { x: 0, y: 0, width, measureText: (text, style) => [...text].length * 10 * ((style?.fontSize ?? 18) / 18) });
  window.happyDOM.abort();
  const runs = layout.fragments.flatMap((fragment) => fragment.runs.map((run) => ({ ...run, baseline: fragment.baseline })));
  const text = (value) => runs.find((run) => run.text === value);
  const shapes = runs.filter((run) => run.type === "image" && run.svg);
  const box = (tag) => layout.boxes.find((record) => tree.nodesById.get(record.nodeId)?.tagName === tag);
  return { layout, tree, runs, text, shapes, box };
}

test("the render tree turns <math> into one math box with MathML children", () => {
  const { tree } = layoutMath('<p>a <math><mi>x</mi><mo>=</mo><mn>2</mn></math></p>');
  const math = [...tree.nodesById.values()].find((node) => node.type === "math");
  expect(math.children.map((child) => [child.type, child.tagName, child.text])).toEqual([
    ["mathml", "mi", "x"], ["mathml", "mo", "="], ["mathml", "mn", "2"]]);
  const block = layoutMath('<math display="block"><mi>y</mi></math>').tree;
  expect([...block.nodesById.values()].some((node) => node.type === "math-block")).toBe(true);
});

test("an infix operator gets 5/18em on each side from the operator dictionary", () => {
  const { text } = layoutMath("<math><mi>x</mi><mo>=</mo><mi>y</mi></math>");
  // x is 10px wide, then 5px space, "=" (10px), 5px space.
  expect(text("x").x).toBe(0);
  expect(text("=").x).toBe(15);
  expect(text("y").x).toBe(30);
});

test("dictionary categories and explicit lspace/rspace follow MathML Core", () => {
  expect(operatorCategory("+", 0)).toBe("B");
  expect(operatorCategory("(", 1)).toBe("ForG");
  expect(operatorCategory("∑", 1)).toBe("J");
  expect(operatorCategory(",", 0)).toBe("M");
  expect(operatorCategory("=", 0)).toBe("none");
  expect(mathLength("0.5em", 18)).toBe(9);
  expect(mathLength("50%", 18, 30)).toBe(15);
  expect(mathLength("5", 18)).toBe(null);
  const { text } = layoutMath('<math><mi>x</mi><mo lspace="0em" rspace="0em">+</mo><mi>y</mi></math>');
  expect(text("+").x).toBe(10);
  expect(text("y").x).toBe(20);
});

test("a single-letter mi is italic, a multi-letter one and mathvariant=normal are not", () => {
  const { text } = layoutMath('<math><mi>x</mi><mi>sin</mi><mi mathvariant="normal">y</mi></math>');
  expect(text("x").style.fontStyle).toBe("italic");
  expect(text("sin").style.fontStyle).toBe("normal");
  expect(text("y").style.fontStyle).toBe("normal");
});

test("a fraction puts its numerator above and denominator below a rule on the math axis", () => {
  const { text, shapes } = layoutMath("<p>a <math><mfrac><mn>1</mn><mn>22</mn></mfrac></math> b</p>");
  const numerator = text("1"), denominator = text("22"), line = text("a ");
  expect(numerator.baseline).toBeLessThan(line.baseline);
  expect(denominator.baseline).toBeGreaterThan(line.baseline);
  // Inline, both parts are one script level smaller, and centred on each other.
  expect(numerator.style.fontSize).toBeCloseTo(18 * 0.71, 5);
  expect(denominator.x + denominator.width / 2).toBeCloseTo(numerator.x + numerator.width / 2, 5);
  const rule = shapes.find((run) => Math.abs(run.width - denominator.width) < 1e-6);
  expect(rule).toBeTruthy();
  // The rule is centred on the axis, a quarter em above the baseline.
  expect(rule.y + rule.height / 2).toBeCloseTo(line.baseline - 18 * 0.25, 5);
  expect(rule.y).toBeGreaterThan(numerator.baseline);
  expect(rule.y + rule.height).toBeLessThan(denominator.y);
});

test("linethickness=0 removes the rule and keeps the two parts apart", () => {
  const { text, shapes } = layoutMath('<math><mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac></math>');
  expect(shapes.length).toBe(0);
  expect(text("k").y).toBeGreaterThan(text("n").y + 10);
});

test("scripts shift up and down and are set at 71% of the base size", () => {
  const { text } = layoutMath("<math><msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup></math>");
  const base = text("x"), sub = text("1"), sup = text("2");
  expect(sup.baseline).toBeLessThan(base.baseline);
  expect(sub.baseline).toBeGreaterThan(base.baseline);
  expect(sub.style.fontSize).toBeCloseTo(18 * 0.71, 5);
  expect(sub.x).toBe(10);
  expect(sup.x).toBe(10);
});

test("display-style limits go under and over a large operator, inline ones become scripts", () => {
  const markup = (display) => `<math display="${display}"><munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover></math>`;
  const block = layoutMath(markup("block"));
  const sum = block.text("∑");
  expect(block.text("n").baseline).toBeLessThan(sum.y);
  expect(block.text("i").y).toBeGreaterThan(sum.baseline);
  // The display operator is drawn larger than the text around it.
  expect(sum.style.fontSize).toBeGreaterThan(18);
  const inline = layoutMath(markup("inline"));
  expect(inline.text("i").x).toBeGreaterThan(inline.text("∑").x);
  expect(inline.text("∑").style.fontSize).toBe(18);
});

test("display math is a block centred in its container", () => {
  const { text } = layoutMath('<div>a</div><math display="block"><mi>x</mi></math><div>b</div>', 200);
  const x = text("x");
  expect(x.x).toBe(95);
  expect(x.y).toBeGreaterThan(text("a").y);
  expect(text("b").y).toBeGreaterThan(x.y);
});

test("a fence stretches to the height of its row and is drawn as a path", () => {
  const { text, shapes } = layoutMath('<math><mo>(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>)</mo></math>');
  expect(text("(")).toBeUndefined();
  const parens = shapes.filter((run) => run.svg.shapes[0].stroke);
  expect(parens.length).toBe(2);
  const a = text("a"), b = text("b");
  for (const paren of parens) {
    expect(paren.y).toBeLessThan(a.y);
    expect(paren.y + paren.height).toBeGreaterThan(b.baseline);
  }
  // Around one line of text the glyph itself is drawn.
  const plain = layoutMath("<math><mo>(</mo><mi>a</mi><mo>)</mo></math>");
  expect(plain.text("(")).toBeTruthy();
});

test("a square root draws a surd and an overbar above its base", () => {
  const { text, shapes } = layoutMath("<math><msqrt><mi>x</mi></msqrt></math>");
  const x = text("x");
  const surd = shapes.find((run) => run.svg.shapes[0].stroke);
  const bar = shapes.find((run) => !run.svg.shapes[0].stroke);
  expect(surd.x + surd.width).toBeLessThanOrEqual(x.x + 1e-6 + surd.svg.shapes[0].strokeWidth * 2);
  expect(bar.y).toBeLessThan(x.y + 2);
  expect(bar.x + bar.width).toBeGreaterThanOrEqual(x.x + x.width);
});

test("an mroot index sits to the left, raised and smaller", () => {
  const { text } = layoutMath("<math><mroot><mi>x</mi><mn>3</mn></mroot></math>");
  expect(text("3").x).toBeLessThan(text("x").x);
  expect(text("3").baseline).toBeLessThan(text("x").baseline);
  expect(text("3").style.fontSize).toBeCloseTo(18 * 0.71 ** 2, 5);
});

test("mtable aligns cells in columns and rows, with mtd padding from the UA stylesheet", () => {
  const { text, box } = layoutMath("<math><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>bb</mi></mtd></mtr><mtr><mtd><mi>ccc</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable></math>");
  // Column one is 30px (ccc) plus 0.4em padding each side; "a" is centred in it.
  expect(text("a").x - text("ccc").x).toBeCloseTo(10, 5);
  expect(text("bb").x).toBeCloseTo(text("d").x - 5, 5);
  expect(text("ccc").y).toBeGreaterThan(text("a").y);
  expect(box("mtd").style.padding[3]).toBeCloseTo(18 * 0.4, 5);
});

test("mspace takes width, mphantom takes space without painting", () => {
  const { text } = layoutMath('<math><mi>a</mi><mspace width="1em"></mspace><mphantom><mi>bb</mi></mphantom><mi>c</mi></math>');
  expect(text("bb")).toBeUndefined();
  expect(text("c").x).toBe(10 + 18 + 20);
});

test("CSS padding and border on a MathML element surround its content", () => {
  const { text, box } = layoutMath('<math><mrow style="padding:3px;border:1px solid red"><mi>x</mi></mrow></math>');
  const row = box("mrow");
  expect(row.width).toBe(10 + 8);
  expect(text("x").x).toBe(4);
  expect(row.style.borderWidths).toEqual([1, 1, 1, 1]);
});

test("inline math sits on the line baseline and flows with the text around it", () => {
  const { text } = layoutMath("<p>ab <math><mi>x</mi></math> cd</p>");
  expect(text("x").baseline).toBe(text("ab ").baseline);
  expect(text("x").x).toBe(30);
  expect(text(" cd").x).toBe(40);
});

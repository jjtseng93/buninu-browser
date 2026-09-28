import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { RenderTreeBuilder, renderTreeText } from "../lib/render-tree/index.js";
import { computeElementStyle, parseDeclarations, StyleEngine } from "../lib/style/computed-style.js";

test("computes the initial UA and inherited style subset", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="parent" style="color: red; font-size: 30px">
      <span id="child">child</span><strong id="strong">bold</strong>
    </div>
  </body>`);
  const engine = new StyleEngine().compute(document);

  expect(engine.get(document.getElementById("parent"))).toMatchObject({
    display: "block",
    color: "rgba(255, 0, 0, 1)",
    fontSize: 30,
  });
  expect(engine.get(document.getElementById("child"))).toMatchObject({
    display: "inline",
    color: "rgba(255, 0, 0, 1)",
    fontSize: 30,
  });
  expect(engine.get(document.getElementById("strong")).fontWeight).toBe(700);
  window.happyDOM.abort();
});

test("inline declarations validate values and preserve important priority", () => {
  const { document, window } = parseHTMLDocument(`<div id="box" style="
    display: block; display: none !important; display: inline;
    padding: 1px 2px 3px 4px; margin: -1px 2px; width: 120px;
    color: not-a-color; background-color: #00ff00;
  "></div>`);
  const style = computeElementStyle(document.getElementById("box"));

  expect(style.display).toBe("none");
  expect(style.padding).toEqual([1, 2, 3, 4]);
  expect(style.margin).toEqual([-1, 2, -1, 2]);
  expect(style.width).toBe(120);
  expect(style.color).toBe("rgba(0, 0, 0, 1)");
  expect(style.backgroundColor).toBe("rgba(0, 255, 0, 1)");
  expect(parseDeclarations(`color: rgb(1, 2, 3); width: calc(10px + 2px)`).size).toBe(2);
  window.happyDOM.abort();
});

test("display none removes a subtree and inline white-space reaches layout input", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div style="display:none">hidden</div>
    <span style="white-space:pre">first\n  second</span>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);

  expect(renderTreeText(tree)).not.toContain("hidden");
  const span = [...tree.nodesById.values()].find((node) => node.tagName === "SPAN");
  expect(span.style.whiteSpace).toBe("pre");
  window.happyDOM.abort();
});

test("external rules cascade through selectors and inherited custom properties", () => {
  const { document, window } = parseHTMLDocument(`<body><main class="page"><p>styled</p></main></body>`);
  const styles = new StyleEngine().compute(document, [`
    :root { --page-bg: #0d1117; --page-text: #e6edf3 }
    html, body { background: var(--page-bg) }
    body { color: var(--page-text) }
    .page p { font-weight: bold }
  `]);

  expect(styles.get(document.body)).toMatchObject({
    backgroundColor: "rgba(13, 17, 23, 1)",
    color: "rgba(230, 237, 243, 1)",
  });
  expect(styles.get(document.querySelector("p"))).toMatchObject({
    color: "rgba(230, 237, 243, 1)",
    fontWeight: 700,
  });
  window.happyDOM.abort();
});

test("computes practical relative lengths and constrained widths", () => {
  const { document, window } = parseHTMLDocument(`<body style="font-size:20px">
    <div style="font-size:1.5em;line-height:1.6;margin:1rem auto;padding:.5em;max-width:50%">box</div>
  </body>`);
  const style = new StyleEngine().compute(document).get(document.querySelector("div"));

  expect(style).toMatchObject({
    fontSize: 30,
    lineHeight: 48,
    margin: [16, "auto", 16, "auto"],
    padding: [15, 15, 15, 15],
    maxWidth: { unit: "%", value: 50 },
  });
  window.happyDOM.abort();
});

test("computes the first paint and flex presentation properties", () => {
  const { document, window } = parseHTMLDocument(`<div style="
    display:flex;flex-direction:column;flex-wrap:wrap;gap:1rem;text-align:center;
    justify-content:space-between;align-items:center;
    border:2px solid #ff0000;border-radius:.5em
  ">box</div>`);
  const style = computeElementStyle(document.querySelector("div"));

  expect(style).toMatchObject({
    display: "flex",
    flexDirection: "column",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    textAlign: "center",
    borderWidths: [2, 2, 2, 2],
    borderColors: Array(4).fill("rgba(255, 0, 0, 1)"),
    borderStyles: Array(4).fill("solid"),
    borderRadius: 8,
  });
  window.happyDOM.abort();
});

test("resolves per-side borders, border-style none and currentColor", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="left" style="color:#00f; border:1px solid #111; border-left:3px solid; border-radius:50%">x</div>
    <div id="none" style="border-width:4px; border-top: thick dashed red">y</div>
    <div id="sides" style="border-style:solid; border-width:1px 2px; border-color:red currentcolor; border-bottom-width:thin">z</div>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const left = styles.get(document.getElementById("left"));

  expect(left.borderWidths).toEqual([1, 1, 1, 3]);
  expect(left.borderColors).toEqual(["rgba(17, 17, 17, 1)", "rgba(17, 17, 17, 1)", "rgba(17, 17, 17, 1)", "rgba(0, 0, 255, 1)"]);
  expect(left.borderRadius).toEqual({ unit: "%", value: 50 });
  // Only the top side has a style, so the other widths compute to 0.
  expect(styles.get(document.getElementById("none")).borderWidths).toEqual([5, 0, 0, 0]);
  const sides = styles.get(document.getElementById("sides"));
  expect(sides.borderWidths).toEqual([1, 2, 1, 2]);
  expect(sides.borderColors).toEqual(["rgba(255, 0, 0, 1)", "rgba(0, 0, 0, 1)", "rgba(255, 0, 0, 1)", "rgba(0, 0, 0, 1)"]);
  window.happyDOM.abort();
});

test("keeps gradient-clipped transparent text visible with a solid fallback", () => {
  const { document, window } = parseHTMLDocument(`<h1 class="slogan">BUNinu Is Not Unix</h1>`);
  const styles = new StyleEngine().compute(document, [`
    :root { --accent: #ffb703; --accent-2: #ff6b6b }
    .slogan {
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
  `]);
  const style = styles.get(document.querySelector("h1"));

  expect(style.backgroundClip).toBe("text");
  expect(style.backgroundImage).toContain("linear-gradient");
  expect(style.color).toBe("rgba(255, 183, 3, 1)");
  window.happyDOM.abort();
});

test("evaluates @media against the viewport and keeps order across stylesheets", () => {
  const { document, window } = parseHTMLDocument(`<body><div id="box">x</div></body>`);
  const sheets = [
    `#box { color: red } @media (max-width: 640px) { #box { padding: 4px } }
     @media print { #box { display: none } } @font-face { font-family: x; src: url(x) }`,
    `#box { color: blue } @media screen and (min-width: 40em) { #box { margin: 0 } }`,
  ];
  const wide = new StyleEngine().compute(document, sheets, { width: 800, height: 600 }).get(document.getElementById("box"));
  const narrow = new StyleEngine().compute(document, sheets, { width: 400, height: 600 }).get(document.getElementById("box"));

  expect(wide).toMatchObject({ color: "rgba(0, 0, 255, 1)", display: "block", padding: [0, 0, 0, 0] });
  expect(narrow.padding).toEqual([4, 4, 4, 4]);
  window.happyDOM.abort();
});

test("applies UA margins, root-relative rem, viewport units and inherited line-height factors", () => {
  const { document, window } = parseHTMLDocument(`<html style="font-size:20px"><body>
    <h1 id="title">t</h1><p id="text">p</p><div id="clamp">c</div>
  </body></html>`);
  const styles = new StyleEngine().compute(document, [`
    body { line-height: 1.5 } p { margin-top: 0 } #clamp { font-size: clamp(1rem, 5vw, 3rem) }
  `], { width: 400, height: 300 });

  expect(styles.get(document.body).margin).toEqual([8, 8, 8, 8]);
  expect(styles.get(document.getElementById("title"))).toMatchObject({ fontSize: 40, fontWeight: 700, lineHeight: 60 });
  expect(styles.get(document.getElementById("title")).margin[0]).toBeCloseTo(26.8);
  expect(styles.get(document.getElementById("text")).margin).toEqual([0, 0, 20, 0]);
  expect(styles.get(document.getElementById("clamp")).fontSize).toBe(20);
  expect(styles.get(document.documentElement).lineHeight).toBeNull();
  window.happyDOM.abort();
});

test("parses font-family lists, box-shadow layers and the background shorthand", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="card">x<code id="code">c</code></div><div id="plain">y</div>
  </body>`);
  const styles = new StyleEngine().compute(document, [`
    #card { font-family: "SF Mono", Menlo, monospace; box-shadow: 0 20px 60px #ffb70340, inset 1px 2px red;
      background: radial-gradient(1200px 500px at 50% -10%, rgba(255,183,3,.16), transparent 60%), linear-gradient(180deg, #111 0%, #222 70%) }
    #plain { background-color: red; background: #0d1117 }
  `]);
  const card = styles.get(document.getElementById("card"));

  expect(card.fontFamily).toEqual(["SF Mono", "Menlo", "monospace"]);
  expect(styles.get(document.getElementById("code")).fontFamily).toEqual(["monospace"]);
  expect(card.boxShadow).toEqual([
    { x: 0, y: 20, blur: 60, spread: 0, color: "rgba(255, 183, 3, 0.2509804)", inset: false },
    { x: 1, y: 2, blur: 0, spread: 0, color: "rgba(255, 0, 0, 1)", inset: true },
  ]);
  // Two gradient layers and no color: the shorthand resets background-color.
  expect(card.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(card.backgroundImage.match(/gradient\(/g)).toHaveLength(2);
  expect(styles.get(document.getElementById("plain"))).toMatchObject({ backgroundColor: "rgba(13, 17, 23, 1)", backgroundImage: null });
  window.happyDOM.abort();
});

test("matches complex selectors with Selectors 4 specificity", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <ul class="list"><li>a</li><li id="b">b</li><li>c</li></ul>
    <a href="/x" target="_blank">x</a>
  </body>`);
  const styles = new StyleEngine().compute(document, [`
    .list > li:not(:last-child) { color: red }
    li:first-child + li { color: blue }
    ul li { color: green }
    :where(#b) { color: black }
    a[target="_blank"] { font-weight: 700 }
    li:hover { color: yellow }
  `]);
  const items = [...document.querySelectorAll("li")];

  // (0,2,1) beats (0,1,2) beats (0,0,2); :where() adds nothing; :hover never matches statically.
  expect(items.map((item) => styles.get(item).color)).toEqual([
    "rgba(255, 0, 0, 1)", "rgba(255, 0, 0, 1)", "rgba(0, 128, 0, 1)",
  ]);
  expect(styles.get(document.querySelector("a")).fontWeight).toBe(700);
  window.happyDOM.abort();
});

test("computes ::before/::after styles only when content generates a box", () => {
  const { document, window } = parseHTMLDocument(`<body><div class="step">a</div><div class="step">b</div></body>`);
  const styles = new StyleEngine().compute(document, [`
    .step:not(:last-child)::after { content: "\\2192  next"; color: orange; display: flex }
    .step:before { content: none }
    .step::placeholder { color: red }
  `]);
  const [first, last] = document.querySelectorAll(".step");

  expect(styles.getPseudo(first, "after")).toMatchObject({ content: "→ next", display: "flex", color: "rgba(255, 165, 0, 1)" });
  expect(styles.getPseudo(last, "after")).toBeNull();
  expect(styles.getPseudo(first, "before")).toBeNull();
  window.happyDOM.abort();
});

test("CSS-wide keywords work for every property and one bad declaration does not stop the cascade", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="parent" style="margin: 7px; padding: 3px; flex-grow: 2">
      <p id="unset" style="margin: unset; padding: initial; color: blue">u</p>
      <p id="inherit" style="margin: inherit; padding-top: inherit; flex-grow: inherit">i</p>
      <p id="revert" style="margin: revert">r</p>
    </div>
  </body>`);
  const engine = new StyleEngine().compute(document);
  expect(engine.get(document.getElementById("unset"))).toMatchObject({
    margin: [0, 0, 0, 0], padding: [0, 0, 0, 0], color: "rgba(0, 0, 255, 1)",
  });
  expect(engine.get(document.getElementById("inherit"))).toMatchObject({
    margin: [7, 7, 7, 7], padding: [3, 0, 0, 0], flexGrow: 2,
  });
  expect(engine.get(document.getElementById("revert")).margin).toEqual([0, 0, 0, 0]);
  window.happyDOM.abort();
});

test("indexed rules still match by id, class, type, escapes and complex selectors, in cascade order", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <main id="app" class="md:flex w-1.5 wide">
      <section class="card"><span class="x">s</span><em>e</em></section>
    </main>
  </body>`);
  const css = `
    #app { width: 100px }
    .md\\:flex { display: flex }
    .w-1\\.5 { min-width: 5px }
    section.card > span { color: red }
    :is(.card) em { color: green }
    [class~="wide"] { max-width: 300px }
    * + em { font-weight: bold }
    span { color: blue }
    .x { font-size: 20px }
  `;
  const engine = new StyleEngine().compute(document, [css]);
  expect(engine.get(document.getElementById("app"))).toMatchObject({
    width: 100, display: "flex", minWidth: 5, maxWidth: 300,
  });
  const span = document.querySelector("span");
  // `span { color: blue }` comes later with lower specificity: the child combinator rule wins.
  expect(engine.get(span)).toMatchObject({ color: "rgba(255, 0, 0, 1)", fontSize: 20 });
  expect(engine.get(document.querySelector("em"))).toMatchObject({ color: "rgba(0, 128, 0, 1)", fontWeight: 700 });
  window.happyDOM.abort();
});

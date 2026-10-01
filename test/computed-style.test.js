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

test("light-dark colors follow the element's color scheme", () => {
  const { document, window } = parseHTMLDocument(`<div id="light" style="color-scheme: light dark; background: light-dark(#eee, #222)"><span id="child" style="color: light-dark(black, white)">text</span></div><div id="dark" style="background-color: light-dark(#eee, #222); color-scheme: only dark"></div>`);
  const engine = new StyleEngine().compute(document);
  expect(engine.get(document.getElementById("light")).backgroundColor).toBe("rgba(238, 238, 238, 1)");
  expect(engine.get(document.getElementById("child")).color).toBe("rgba(0, 0, 0, 1)");
  expect(engine.get(document.getElementById("dark")).backgroundColor).toBe("rgba(34, 34, 34, 1)");
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

test("the rule index and ancestor filter never drop a matching rule", () => {
  const { document, window } = parseHTMLDocument(`<html class="dark"><body>
    <main id="m" data-x="1" class="a"><section class="s"><p class="p" title="t">x</p><span>y</span><em>z</em></section>
    <ul><li>1</li><li class="last">2</li></ul></main></body></html>`);
  const css = `
    :root { color: red }
    html.dark p { color: blue }
    [data-x] { width: 10px }
    [data-x="1"] .p { height: 5px }
    [title] { font-weight: bold }
    :is(.p, span) { font-size: 20px }
    :where(em, .nothing) { min-width: 4px }
    .s > * { padding: 1px }
    .a .s + ul li:last-child { color: green }
    .p ~ em { margin: 2px }
    main:not(.zzz) span { display: block }
    [x="a]#m"] { color: pink }
    .missing-ancestor .p { color: orange }
    section p::before { content: "b" }
  `;
  const engine = new StyleEngine().compute(document, [css]);
  const get = (selector) => engine.get(document.querySelector(selector));
  expect(get("html").color).toBe("rgba(255, 0, 0, 1)");
  expect(get("p")).toMatchObject({ color: "rgba(0, 0, 255, 1)", height: 5, fontWeight: 700, fontSize: 20, padding: [1, 1, 1, 1] });
  expect(get("main")).toMatchObject({ width: 10, color: "rgba(255, 0, 0, 1)" });
  expect(get("span")).toMatchObject({ fontSize: 20, display: "block", padding: [1, 1, 1, 1] });
  expect(get("em")).toMatchObject({ minWidth: 4, margin: [2, 2, 2, 2] });
  expect(get("li.last").color).toBe("rgba(0, 128, 0, 1)");
  expect(get("li").color).toBe("rgba(255, 0, 0, 1)");
  expect(engine.getPseudo(document.querySelector("p"), "before")?.content).toBe("b");
  window.happyDOM.abort();
});

test("custom properties keep their case, take inline style, and var() fallbacks may nest", () => {
  const { document, window } = parseHTMLDocument(`<div id="a" style="--paneWidth: var(--wide); --wide: 320px; width: var(--paneWidth)">
    <p id="b">x</p><p id="c">y</p><p id="d">z</p></div>`);
  const css = `
    :root { --borderColor-default: #d1d9e0; --loop: var(--loop) }
    #a { --paneWidth: 0 }
    #b { color: var(--borderColor-default); background-color: var(--missing, var(--borderColor-default)) }
    #c { color: var(--missing, rgba(10, 20, 30, 1)) }
    #d { color: var(--loop, blue); width: var(--paneWidth) }
  `;
  const engine = new StyleEngine().compute(document, [css]);
  const get = (id) => engine.get(document.getElementById(id));
  // Inline --paneWidth wins over the stylesheet's value.
  expect(get("a").width).toBe(320);
  expect(get("b")).toMatchObject({ color: "rgba(209, 217, 224, 1)", backgroundColor: "rgba(209, 217, 224, 1)" });
  expect(get("c").color).toBe("rgba(10, 20, 30, 1)");
  // A property in a reference cycle is invalid, so its fallback applies.
  expect(get("d")).toMatchObject({ color: "rgba(0, 0, 255, 1)", width: 320 });
  window.happyDOM.abort();
});


test("cascade layers: unlayered beats layered, later layers win, !important reverses", () => {
  const { document, window } = parseHTMLDocument(`<p id="a" class="x y">t</p><p id="b" class="x">u</p>`);
  const css = [
    `@layer base, components;
     @layer components { .x { display: inline } }
     @layer base { .x { display: flex; color: red !important } p { margin-top: 5px } }
     .y { display: block }`,
    `.x { color: blue !important } @layer base.inner { .x { visibility: hidden } }`,
  ];
  const engine = new StyleEngine().compute(document, css);
  const get = (id) => engine.get(document.getElementById(id));
  expect(get("a").display).toBe("block");
  expect(get("b").display).toBe("inline");
  expect(get("a").color).toBe("rgba(255, 0, 0, 1)");
  // A layered author rule still beats the user-agent defaults.
  expect(get("a").margin).toEqual([5, 0, 16, 0]);
  expect(get("b").visibility).toBe("hidden");
  window.happyDOM.abort();
});

test("the font shorthand resets its parts and competes with font-size in the cascade", () => {
  const { document, window } = parseHTMLDocument(`<h2 id="a" style="font-size:32px;line-height:3">t</h2><h2 id="b">x</h2>
    <p id="c" style="font:italic small-caps bold 12px/1.5 Georgia, serif">u</p><p id="d" style="font-size:large">v</p>`);
  const engine = new StyleEngine().compute(document, ["#a, #b { font: 600 1rem/1.5 sans-serif } h2 { font-size: 40px }"]);
  const get = (id) => engine.get(document.getElementById(id));
  expect(get("a")).toMatchObject({ fontSize: 32, fontWeight: 600, lineHeightFactor: 3 });
  expect(get("b")).toMatchObject({ fontSize: 16, fontWeight: 600, lineHeightFactor: 1.5 });
  expect(get("c")).toMatchObject({ fontSize: 12, fontWeight: 700, fontFamily: ["Georgia", "serif"] });
  expect(get("d").fontSize).toBe(18);
  window.happyDOM.abort();
});

test("calc() sums lengths and percentages; percentages resolve at layout time", () => {
  const { document, window } = parseHTMLDocument(`<body style="font-size:10px">
    <div id="a" style="max-width:calc(100% + 32px);width:calc(2em + 3px * 2);min-width:calc((100% - 20px) / 2)"></div>
    <div id="b" style="width:calc(50% -10px);height:calc(100px - 2 * 1em + calc(4px));max-width:min(100%, 500px)"></div>
    <div id="c" style="width:calc(10px + 5);max-width:calc(100% * 50%);height:calc(1px / 0);margin-left:calc(10% + 1px)"></div>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const style = (id) => styles.get(document.getElementById(id));
  expect(style("a")).toMatchObject({
    maxWidth: { unit: "math", kind: "calc", px: 32, percent: 100 },
    width: 26,
    minWidth: { unit: "math", kind: "calc", px: -10, percent: 50 },
  });
  // "50% -10px" (no space after the minus) still subtracts
  expect(style("b")).toMatchObject({
    width: { unit: "math", kind: "calc", px: -10, percent: 50 },
    height: 84,
    maxWidth: { unit: "math", kind: "min" },
  });
  // Invalid: length + number, % * %, division by zero, % where no percentages are allowed
  expect(style("c")).toMatchObject({ width: "auto", maxWidth: "none", height: "auto", margin: [0, 0, 0, 0] });
  window.happyDOM.abort();
});

test("links get the UA link style; text decorations propagate to in-flow descendants", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <a id="link" href="javascript:void 0"><span id="inside">x</span><span id="atomic" style="display:inline-block">y</span></a>
    <a id="anchor" name="n">no href</a>
    <p id="own" style="text-decoration: line-through red wavy 2px">
      <em id="nested" style="text-decoration-line: underline overline">z</em>
      <span id="cleared" style="text-decoration: none">still struck</span></p>
    <p id="bad" style="text-decoration: underline blue; text-decoration-color: nonsense">b</p>
    <p id="invalid" style="text-decoration: sparkly">c</p>
  </body>`);
  const styles = new StyleEngine().compute(document);
  const style = (id) => styles.get(document.getElementById(id));
  expect(style("link")).toMatchObject({ color: "rgba(0, 0, 238, 1)", textDecorations: { lines: ["underline"], color: "rgba(0, 0, 238, 1)" } });
  expect(style("inside").textDecorations).toEqual({ lines: ["underline"], color: "rgba(0, 0, 238, 1)" });
  expect(style("atomic").textDecorations).toBeNull();
  expect(style("anchor")).toMatchObject({ color: "rgba(0, 0, 0, 1)", textDecorations: null });
  expect(style("own").textDecorations).toEqual({ lines: ["line-through"], color: "rgba(255, 0, 0, 1)" });
  expect(style("nested").textDecorations).toEqual({ lines: ["line-through", "underline", "overline"], color: "rgba(0, 0, 0, 1)" });
  // "none" on a descendant does not remove what an ancestor draws.
  expect(style("cleared").textDecorations).toEqual({ lines: ["line-through"], color: "rgba(255, 0, 0, 1)" });
  expect(style("bad").textDecorations).toEqual({ lines: ["underline"], color: "rgba(0, 0, 255, 1)" });
  expect(style("invalid").textDecorations).toBeNull();
  window.happyDOM.abort();
});

test("the font shorthand allows spaces around the line-height slash", () => {
  for (const font of ['14px / 1.5 "Mona Sans VF", sans-serif', '14px/ 1.5 "Mona Sans VF", sans-serif',
    '14px /1.5 "Mona Sans VF", sans-serif', '14px/1.5 "Mona Sans VF", sans-serif']) {
    const { document, window } = parseHTMLDocument(`<p style='font: ${font}'><span>x</span></p>`);
    const engine = new StyleEngine().compute(document);
    for (const element of [document.querySelector("p"), document.querySelector("span")]) {
      const style = engine.get(element);
      expect([style.fontSize, style.lineHeight, style.fontFamily]).toEqual([14, 21, ["Mona Sans VF", "sans-serif"]]);
    }
    window.happyDOM.abort();
  }
});

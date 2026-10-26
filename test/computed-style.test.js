import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { RenderTreeBuilder, renderTreeText } from "../lib/render-tree/index.js";
import {
  absolutizeStyleSheetUrls, computeElementStyle, extractFontFaces, matchSelectors, parseDeclarations, StyleEngine,
  parseStyleSheet,
} from "../lib/style/computed-style.js";

test("escaped selector punctuation does not consume following stylesheet rules", () => {
  const { document, window } = parseHTMLDocument(`<div id="quoted" class="[feature:'alt']"></div><div id="punctuation" class="braces{}paren(,)"></div><div id="after" class="after"></div>`);
  const css = String.raw`@layer utilities {
    .\[feature\:\'alt\'\] { width: 20px }
    .braces\{\}paren\(\,\) { height: 30px }
    .after { --size: 40px; width: var(--size); height: 50px }
  }`;
  expect(parseStyleSheet(css)).toHaveLength(3);
  const styles = new StyleEngine().compute(document, [css]);
  expect(styles.get(document.getElementById('quoted')).width).toBe(20);
  expect(styles.get(document.getElementById('punctuation')).height).toBe(30);
  expect(styles.get(document.getElementById('after')).width).toBe(40);
  expect(styles.get(document.getElementById('after')).height).toBe(50);
  window.happyDOM.abort();
});

test("border corner longhands, elliptical shorthand and logical corners follow the cascade", () => {
  const { document, window } = parseHTMLDocument(`<div id="parent" style="border-radius:10px 20px 30px / 40px 50%;border-top-left-radius:3px 4px">
    <div id="child" style="border-radius:inherit; border-bottom-left-radius:initial"></div></div>
    <div id="logical" style="border-start-start-radius:9px;border-end-end-radius:11px;direction:rtl"></div>
    <div id="invalid" style="border-radius:7px; border-top-left-radius:-2px; border-top-right-radius:1px 2px 3px"></div>`);
  const styles = new StyleEngine().compute(document);
  const parent = styles.get(document.querySelector('#parent'));
  expect(parent.borderTopLeftRadius).toEqual([3, 4]);
  expect(parent.borderTopRightRadius).toEqual([20, { unit: '%', value: 50 }]);
  expect(parent.borderBottomRightRadius).toEqual([30, 40]);
  expect(parent.borderBottomLeftRadius).toEqual([20, { unit: '%', value: 50 }]);
  const child = styles.get(document.querySelector('#child'));
  expect(child.borderTopLeftRadius).toEqual([3, 4]);
  expect(child.borderBottomLeftRadius).toEqual([0, 0]);
  const logical = styles.get(document.querySelector('#logical'));
  expect(logical.borderTopRightRadius).toEqual([9, 9]);
  expect(logical.borderBottomLeftRadius).toEqual([11, 11]);
  const invalid = styles.get(document.querySelector('#invalid'));
  expect(invalid.borderTopLeftRadius).toEqual([7, 7]);
  expect(invalid.borderTopRightRadius).toEqual([7, 7]);
  window.happyDOM.close();
});

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

test(":empty includes text nodes, but ignores comments and empty text nodes", () => {
  const { document, window } = parseHTMLDocument('<span id="text">0</span><span id="space"> </span><span id="empty"><!--comment--></span>');
  const styles = new StyleEngine().compute(document, ['span:empty { display:none }']);
  expect(document.querySelector('#text').matches(':empty')).toBe(false);
  expect(styles.get(document.querySelector('#text')).display).toBe('inline');
  expect(styles.get(document.querySelector('#space')).display).toBe('inline');
  expect(styles.get(document.querySelector('#empty')).display).toBe('none');
  window.happyDOM.abort();
});

test("percentage root fonts set the basis for rem and descendant percentage fonts", () => {
  const { document, window } = parseHTMLDocument(`<html style="font-size:62.5%"><body>
    <div id="relative" style="font-size:1.4rem"><span id="child" style="font-size:150%">text</span></div>
  </body></html>`);
  const styles = new StyleEngine().compute(document);
  expect(styles.get(document.documentElement).fontSize).toBe(10);
  expect(styles.get(document.getElementById('relative')).fontSize).toBe(14);
  expect(styles.get(document.getElementById('child')).fontSize).toBe(21);
  window.happyDOM.abort();
});

test("ch lengths use the final font's zero advance independent of declaration order", () => {
  const { document, window } = parseHTMLDocument(`<body style="font-size:20px; font-family:parent">
    <div id="a" style="max-width:64ch; padding:1ch; font:30px child; font-weight:700"></div>
    <div id="b" style="font:30px child; font-weight:700; max-width:64ch; padding:1ch"></div>
    <div id="c" style="width:calc(2ch + 10px); font-size:2ch"></div>
  </body>`);
  const measureText = (text, style) => {
    expect(text).toBe("0");
    return style.fontSize * (style.fontFamily[0] === "child" && style.fontWeight === 700 ? 0.6 : 0.5);
  };
  const styles = new StyleEngine({ measureText }).compute(document);
  for (const id of ["a", "b"]) {
    const style = styles.get(document.getElementById(id));
    expect(style.maxWidth).toBe(1152);
    expect(style.padding).toEqual([18, 18, 18, 18]);
  }
  const child = styles.get(document.getElementById("c"));
  expect(child.fontSize).toBe(20);
  expect(child.width).toBe(30);
  window.happyDOM.abort();
});

test("ch falls back to half an em without font measurements and preserves font cascade", () => {
  const { document, window } = parseHTMLDocument(`<div style="width:10ch; font-family:custom; font:20px monospace; line-height:2"></div>`);
  const style = computeElementStyle(document.querySelector("div"));
  expect(style.width).toBe(100);
  expect(style.fontFamily).toEqual(["monospace"]);
  expect(style.lineHeight).toBe(40);
  window.happyDOM.abort();
});

test("logical spacing, sizes and insets resolve in physical cascade order", () => {
  const { document, window } = parseHTMLDocument(`<div dir="rtl" style="
    padding:1px; padding-inline:2px 3px; padding-inline-start:4px; padding-left:5px;
    margin-block:6px 7px; margin-inline:auto; inline-size:100px; min-block-size:20px;
    inset-block:8px 9px; inset-inline-start:10px;
  "></div>`);
  const style = computeElementStyle(document.querySelector("div"));
  expect(style.padding).toEqual([1, 4, 1, 5]);
  expect(style.margin).toEqual([6, "auto", 7, "auto"]);
  expect(style.inset).toEqual([8, 10, 9, "auto"]);
  expect(style.width).toBe(100);
  expect(style.minHeight).toBe(20);
  window.happyDOM.abort();
});

test("logical declarations use final direction and reject invalid paired values together", () => {
  const { document, window } = parseHTMLDocument(`<div style="
    padding-inline-start:10px; direction:rtl; padding-block:1px -2px;
    margin-inline:2px invalid; inline-size:90px; width:100px;
  "><i style="padding-inline-start:inherit"></i></div>`);
  const engine = new StyleEngine().compute(document);
  const style = engine.get(document.querySelector("div"));
  expect(style.padding).toEqual([0, 10, 0, 0]);
  expect(style.margin).toEqual([0, 0, 0, 0]);
  expect(style.width).toBe(100);
  expect(engine.get(document.querySelector("i")).padding).toEqual([0, 10, 0, 0]);
  window.happyDOM.abort();
});

test("flex-flow sets both longhands and resets omitted components", () => {
  const { document, window } = parseHTMLDocument(`<div style="flex-direction:column;flex-flow:wrap"></div>
    <i style="flex-flow:wrap column;flex-wrap:nowrap"></i>`);
  expect(computeElementStyle(document.querySelector("div"))).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
  expect(computeElementStyle(document.querySelector("i"))).toMatchObject({ flexDirection: "column", flexWrap: "nowrap" });
  window.happyDOM.abort();
});

test("font styles inherit and the shorthand resets or inherits every supported component", () => {
  const { document, window } = parseHTMLDocument(`<main style="font:italic bold condensed 20px/2 monospace">
    <i id="reset" style="font:12px serif"></i><span id="inherited" style="font:inherit"></span>
    <b id="override" style="font:oblique 16px serif;font-style:normal"></b><em></em>
  </main>`);
  const engine = new StyleEngine().compute(document);
  expect(engine.get(document.querySelector("main"))).toMatchObject({ fontStyle: "italic", fontSize: 20, fontWeight: 700, fontStretch: 75 });
  expect(engine.get(document.querySelector("#reset"))).toMatchObject({ fontStyle: "normal", fontSize: 12, fontWeight: 400, fontStretch: 100 });
  expect(engine.get(document.querySelector("#inherited"))).toMatchObject({ fontStyle: "italic", fontSize: 20, fontWeight: 700, fontStretch: 75, lineHeight: 40 });
  expect(engine.get(document.querySelector("#override")).fontStyle).toBe("normal");
  expect(engine.get(document.querySelector("em")).fontStyle).toBe("italic");
  window.happyDOM.abort();
});

test("font-face extraction keeps resource candidates, weight ranges and unicode subsets", () => {
  const faces = extractFontFaces(`@font-face {
    font-family: 'Example Sans'; font-weight: 100 900; font-style: italic; font-stretch:62% 125%; font-display:swap;
    src: local('Example Sans Regular'), url('../fonts/a.woff2') format('woff2'), url(b.ttf) format(truetype);
    unicode-range: U+0-FF, U+4??, U+1F600;
  }`, "https://example.test/css/main.css");
  expect(faces).toEqual([{ family: "Example Sans", weight: [100, 900], style: "italic", stretch: [62, 125], display: "swap",
    sources: [{ local: "Example Sans Regular" }, { url: "https://example.test/fonts/a.woff2", format: "woff2" },
      { url: "https://example.test/css/b.ttf", format: "truetype" }],
    unicodeRanges: [[0, 255], [1024, 1279], [128512, 128512]] }]);
});

test("font stretch percentages, width alias and ch measurements share the final font", () => {
  const { document, window } = parseHTMLDocument(`<main style="font-stretch:87.5%"><div style="width:10ch;font-width:75%"></div>
    <i style="font-width:unset"></i><b style="font-stretch:expanded;font-width:-2%"></b></main>`);
  const engine = new StyleEngine({ measureText: (_text, style) => style.fontStretch / 10 }).compute(document);
  expect(engine.get(document.querySelector("div"))).toMatchObject({ fontStretch: 75, width: 75 });
  expect(engine.get(document.querySelector("i")).fontStretch).toBe(87.5);
  expect(engine.get(document.querySelector("b")).fontStretch).toBe(125);
  window.happyDOM.abort();
});

test("small, large and dynamic viewport units track the headless viewport on resize", () => {
  const {document,window} = parseHTMLDocument('<main style="min-height:100dvh;width:50svi;padding:2vmin 3lvmax"><i style="height:calc(100svh - 20px);width:20dvb"></i></main>');
  const engine = new StyleEngine();
  for (const [width,height] of [[1000,600],[400,800]]) {
    engine.compute(document, [], {width,height});
    expect(engine.get(document.querySelector('main'))).toMatchObject({minHeight:height,width:width/2,
      padding:[Math.min(width,height)*.02,Math.max(width,height)*.03,Math.min(width,height)*.02,Math.max(width,height)*.03]});
    expect(engine.get(document.querySelector('i'))).toMatchObject({height:height-20,width:height*.2});
  }
  window.happyDOM.abort();
});

test("container query units use the small viewport when no query container exists", () => {
  const {document,window} = parseHTMLDocument(`<main style="width:25cqw;height:25cqh;padding:2cqmin 3cqmax">
    <i style="width:10cqi;height:10cqb"></i><b style="--size:clamp(48px,25cqw,136px);width:var(--size);height:calc(var(--size) / 2)"></b></main>`);
  const engine = new StyleEngine();
  for (const [width,height] of [[1000,600],[400,800]]) {
    engine.compute(document, [], {width,height});
    expect(engine.get(document.querySelector('main'))).toMatchObject({width:width/4,height:height/4,
      padding:[Math.min(width,height)*.02,Math.max(width,height)*.03,Math.min(width,height)*.02,Math.max(width,height)*.03]});
    expect(engine.get(document.querySelector('i'))).toMatchObject({width:width*.1,height:height*.1});
    const size=Math.max(48,Math.min(width*.25,136));
    expect(engine.get(document.querySelector('b'))).toMatchObject({width:size,height:size/2});
  }
  window.happyDOM.abort();
});

test("author all resets override HTML and SVG presentation hints even inside cascade layers", () => {
  const {document,window}=parseHTMLDocument('<img width="80" height="40"><svg><rect fill="red" stroke="blue"></rect></svg>');
  const engine=new StyleEngine().compute(document,['@layer reset{img,rect{all:unset}}']);
  expect(engine.get(document.querySelector('img'))).toMatchObject({width:'auto',height:'auto'});
  expect(engine.get(document.querySelector('rect'))).toMatchObject({fill:'rgba(0, 0, 0, 1)',stroke:'none'});
  window.happyDOM.abort();
});

test("font-face extraction follows matching group rules and ignores invalid faces", () => {
  const face = (family) => `@font-face { font-family:${family}; src:url(${family}.ttf) }`;
  const faces = extractFontFaces(`@media (min-width:900px) { ${face("Wide")} }
    @media (max-width:899px) { @layer text { ${face("Narrow")} } }
    @supports (display:grid) { ${face("Supported")} }
    @font-face { font-family: serif; src:url(bad.ttf) }
    @font-face { font-family: MissingSource }
    div { content:'@font-face { font-family:Fake; src:url(fake.ttf) }' }`,
    "https://example.test/main.css", { width: 800 });
  expect(faces.map((face) => face.family)).toEqual(["Narrow", "Supported"]);
  expect(faces[0]).toMatchObject({ weight: [400, 400], style: "normal", unicodeRanges: [[0, 0x10ffff]] });
});

test("font-face strings allow escaped names and commas inside URLs", () => {
  const [face] = extractFontFaces(String.raw`@font-face { font-family:'A\20 B';
    src:url('data:font/ttf;base64,AA==') format('truetype'), url('name(1).woff2') format('woff2') tech(variations);
    unicode-range:U+110000; font-weight:1500;
  }`, "https://example.test/main.css");
  expect(face.family).toBe("A B");
  expect(face.sources).toEqual([{ url: "data:font/ttf;base64,AA==", format: "truetype" },
    { url: "https://example.test/name(1).woff2", format: "woff2", tech: ["variations"] }]);
  expect(face.weight).toEqual([400, 400]);
  expect(face.unicodeRanges).toEqual([[0, 0x10ffff]]);
});

test("all unset removes UA heading styles while inheriting fonts and retaining custom properties", () => {
  const { document, window } = parseHTMLDocument(`<main style="font:36px/50px monospace;color:red;direction:rtl">
    <h1 style="all:unset;--size:24px;padding-inline-start:var(--size)">Title</h1>
  </main>`);
  const engine = new StyleEngine().compute(document);
  const style = engine.get(document.querySelector("h1"));
  expect(style).toMatchObject({ display: "inline", fontSize: 36, fontWeight: 400, lineHeight: 50,
    color: "rgba(255, 0, 0, 1)", direction: "rtl" });
  expect(style.fontFamily).toEqual(["monospace"]);
  expect(style.margin).toEqual([0, 0, 0, 0]);
  expect(style.padding).toEqual([0, 24, 0, 0]);
  window.happyDOM.abort();
});

test("all reset participates in importance, source order and font-relative sizing", () => {
  const { document, window } = parseHTMLDocument(`<div class="x" style="all:initial; font-size:20px; width:2em; padding-left:3px"></div>
    <p class="x" style="font-size:20px;all:unset!important;width:10px"></p>`);
  const engine = new StyleEngine().compute(document, [".x { margin:10px; color:red!important; font:30px serif }"]);
  const first = engine.get(document.querySelector("div"));
  expect(first).toMatchObject({ display: "inline", fontSize: 20, width: 40, color: "rgba(255, 0, 0, 1)" });
  expect(first.fontFamily).toEqual(["sans-serif"]);
  expect(first.padding).toEqual([0, 0, 0, 3]);
  expect(first.margin).toEqual([0, 0, 0, 0]);
  expect(engine.get(document.querySelector("p"))).toMatchObject({ width: "auto", fontSize: 16, color: "rgba(0, 0, 0, 1)" });
  window.happyDOM.abort();
});

test("CSS-wide side resets preserve the other border and inset sides", () => {
  const { document, window } = parseHTMLDocument(`<div style="border:3px solid red;border-left-width:initial;border-bottom-color:initial;inset:5px;top:initial"></div>`);
  const style = computeElementStyle(document.querySelector("div"));
  expect(style.borderWidths).toEqual([3, 3, 3, 3]);
  expect(style.borderColors).toEqual(["rgba(255, 0, 0, 1)", "rgba(255, 0, 0, 1)", "rgba(0, 0, 0, 1)", "rgba(255, 0, 0, 1)"]);
  expect(style.inset).toEqual(["auto", 5, 5, 5]);
  window.happyDOM.abort();
});

test("complex functional selectors style the subject, not the first compound", () => {
  const { document, window } = parseHTMLDocument(`<main class="prose"><h2 id="heading">Title <code id="code">code</code></h2>
    <section class="not-prose"><h2 id="excluded">Excluded</h2></section></main>`);
  const engine = new StyleEngine().compute(document, [`
    h2 { font-size:inherit }
    .prose :where(h2):not(:where(.not-prose, .not-prose *)) {font-size:24px}
    .prose :where(h2 code):not(:where(.not-prose, .not-prose *)) {font-size:.875em}
  `]);
  expect(engine.get(document.getElementById("heading")).fontSize).toBe(24);
  expect(engine.get(document.getElementById("code")).fontSize).toBe(21);
  expect(engine.get(document.getElementById("excluded")).fontSize).toBe(16);
  expect([...document.querySelectorAll(":is(.prose h2 > code)")].map(e => e.id)).toEqual(["code"]);
  expect(document.getElementById("heading").matches(":is(*)")).toBe(true);
  expect(document.getElementById("heading").matches(":where(h2 code)")).toBe(false);
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

test("sheets parsed once keep layer order and cascade when the sheet list changes or repeats", () => {
  const { document, window } = parseHTMLDocument(`<p id="a" class="x">t</p><p id="b" class="y">u</p>`);
  const base = `@layer one, two; @layer two { .x { color: blue } } @layer one { .x { color: red; display: flex } }`;
  const anonymous = `@layer { .y { color: green !important } } .y { display: inline }`;
  const later = `@layer three { .x { display: block } } .y { color: black }`;
  const lists = [
    [base, later],
    [base, later, base], // a repeated sheet: its earlier copy still declares the layers first
    [later, base],
    [anonymous, later, anonymous], // anonymous layers: both copies count under !important
    [later, `@layer two { .x { display: grid } }`, base],
  ];
  const engine = new StyleEngine();
  for (const sheets of lists) {
    engine.compute(document, sheets, {}, new Set([document.body]), null);
    const fresh = new StyleEngine().compute(document, sheets.map((sheet) => `${sheet} `));
    for (const id of ["a", "b"]) expect(engine.get(document.getElementById(id))).toEqual(fresh.get(document.getElementById(id)));
  }
  engine.compute(document, [base, later, base]);
  expect(engine.get(document.getElementById("a")).color).toBe("rgba(0, 0, 255, 1)");
  expect(engine.get(document.getElementById("a")).display).toBe("block");
  window.happyDOM.abort();
});

test("matchSelectors finds what querySelectorAll finds, in one walk", () => {
  const { document, window } = parseHTMLDocument(`<main><ul><li class="a">1</li><li id="i">2</li><li class="a b">3</li></ul>
    <p>x</p><p class="a"><span>y</span></p><div><span hidden>z</span></div></main>`);
  const selectors = ["li:first-child", ".a + li", "li ~ .b", "p:has(span)", ":is(ul, div) > *", "#i", "[hidden]", "*", ":root", "main span", "1x", "li:nth-child(2n+1)"];
  // Elements compared as sets of document positions (deep equality of DOM
  // nodes is slow, and querySelectorAll() may list an element twice).
  const all = [...document.querySelectorAll("*")];
  const positions = (elements) => [...new Set(elements)].map((element) => all.indexOf(element)).sort((x, y) => x - y);
  const matched = matchSelectors(document, selectors);
  for (const selector of selectors) {
    let expected = null;
    try { expected = positions(document.querySelectorAll(selector)); } catch {}
    expect(matched.has(selector) ? positions(matched.get(selector)) : null).toEqual(expected);
  }
  // From an element: its descendants and the element itself.
  const ul = document.querySelector("ul");
  expect(positions(matchSelectors(ul, [":is(ul, li)"]).get(":is(ul, li)"))).toEqual(positions([ul, ...ul.children]));
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

test("incremental restyling retains equal computed-style identities", () => {
  const { document, window } = parseHTMLDocument(`<body><div><span>same</span></div></body>`);
  const div = document.querySelector("div");
  const span = document.querySelector("span");
  const engine = new StyleEngine().compute(document, [".active { color: red }"]);
  const before = [engine.get(div), engine.get(span)];
  // Visiting this subtree is conservative: the class changes, but neither
  // element's final values change.
  div.className = "unmatched";
  engine.compute(document, [".active { color: red }"], {}, new Set([div]));
  expect([engine.get(div), engine.get(span)]).toEqual(before);
  expect(engine.get(div)).toBe(before[0]);
  expect(engine.get(span)).toBe(before[1]);
  window.happyDOM.abort();
});

test("incremental restyles of changed subtrees and added sheets equal a full restyle", () => {
  const { document, window } = parseHTMLDocument(`<body><div id="a" class="x"><p>one</p><p>two</p></div><div id="b"><span>s</span></div></body>`);
  const sheets = [".x p { color: red } .y p { color: blue; font-size: 20px } #b span { font-weight: 700 }"];
  const engine = new StyleEngine().compute(document, sheets);
  const same = (label) => {
    const reference = new StyleEngine().compute(document, engine.sheets ?? sheets);
    for (const element of document.querySelectorAll("*")) {
      expect([label, JSON.stringify(engine.get(element))]).toEqual([label, JSON.stringify(reference.get(element))]);
    }
  };
  // An attribute change: only #a's subtree.
  document.getElementById("a").className = "y";
  engine.compute(document, sheets, {}, new Set([document.getElementById("a")]));
  expect([engine.incremental, engine.restyled]).toEqual([true, 3]);
  same("class change");
  // Inserted elements: their parent's subtree.
  const b = document.getElementById("b");
  b.insertAdjacentHTML("beforeend", "<span>t</span><p>u</p>");
  engine.compute(document, sheets, {}, new Set([b]));
  expect(engine.restyled).toBe(4);
  same("insertion");
  // An added sheet restyles what its rules match, nothing else.
  const more = [...sheets, "span { color: green }"];
  engine.compute(document, more, {}, new Set());
  expect([engine.incremental, engine.restyled]).toEqual([true, 2]); // the two spans
  engine.sheets = more;
  same("added sheet");
  window.happyDOM.abort();
});

test("background shorthand and longhands keep image layers with their position, size and repeat", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="short" style="background: url(icon.png) no-repeat center / 32px 16px, linear-gradient(red, blue) #fff"></div>
    <div id="long" style="background: url('a.png'); background-size: cover; background-position: right 4px top; background-repeat: repeat-x"></div>
    <div id="color" style="background: url(x.png); background: #000"></div>
    <div id="invalid" style="background: url(x.png) bogus-token"></div>
  </body>`);
  const engine = new StyleEngine().compute(document);
  const style = (id) => engine.get(document.getElementById(id));
  expect(style("short")).toMatchObject({
    backgroundImage: "url(icon.png), linear-gradient(red, blue)",
    backgroundPosition: "center, 0% 0%",
    backgroundSize: "32px 16px, auto",
    backgroundRepeat: "no-repeat, repeat",
    backgroundColor: "rgba(255, 255, 255, 1)",
  });
  expect(style("long")).toMatchObject({
    backgroundImage: "url('a.png')", backgroundSize: "cover", backgroundPosition: "right 4px top", backgroundRepeat: "repeat-x",
  });
  // A later shorthand resets the image layers.
  expect(style("color")).toMatchObject({ backgroundImage: null, backgroundColor: "rgba(0, 0, 0, 1)" });
  // An invalid shorthand is dropped as a whole.
  expect(style("invalid")).toMatchObject({ backgroundImage: null, backgroundColor: "rgba(0, 0, 0, 0)" });
  window.happyDOM.abort();
});

test("a linked style sheet's url()s resolve against the sheet", () => {
  expect(absolutizeStyleSheetUrls(
    `a { background: url(img/a.png) } b { background: url("../b.png") } c { background: url(data:image/png;base64,AA) }
     d { background: url(https://cdn.test/d.png) } e { mask: url(#m) }`,
    "https://site.test/css/main.css",
  )).toBe(`a { background: url(https://site.test/css/img/a.png) } b { background: url("https://site.test/b.png") } c { background: url(data:image/png;base64,AA) }
     d { background: url(https://cdn.test/d.png) } e { mask: url(#m) }`);
});

test("form controls default to readable dark text but author colors still win", () => {
  const {document,window}=parseHTMLDocument(`<body style="color:lightblue"><textarea></textarea><input><button>Button</button><select><option>Option</option></select><textarea id="inherit" style="color:inherit"></textarea><input id="custom" style="color:red"></body>`);
  try {
    const styles=new StyleEngine().compute(document);
    for(const e of document.querySelectorAll('textarea,input,button,select')) {
      if(!e.id)expect(styles.get(e).color).toBe('rgba(0, 0, 0, 1)');
    }
    expect(styles.get(document.querySelector('#inherit')).color).toBe(styles.get(document.body).color);
    expect(styles.get(document.querySelector('#custom')).color).toBe('rgba(255, 0, 0, 1)');
  } finally {window.happyDOM.abort()}
});

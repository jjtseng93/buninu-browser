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
    margin: [22, "auto", 22, "auto"],
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
    gap: 22,
    textAlign: "center",
    borderWidth: 2,
    borderColor: "rgba(255, 0, 0, 1)",
    borderRadius: 11,
  });
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

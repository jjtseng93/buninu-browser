import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { layoutText } from "../lib/layout/text-layout.js";
import { buildDisplayList } from "../lib/paint/display-list.js";
import { RenderTreeBuilder } from "../lib/render-tree/index.js";
import { extractSvg, parseTransform } from "../lib/render-tree/svg.js";
import { StyleEngine } from "../lib/style/computed-style.js";

test("extracts shapes with inherited paint, currentColor and transforms", () => {
  const { document, window } = parseHTMLDocument(`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M0 0h4v4z"/>
    <g fill="#f00" stroke="blue" stroke-width="2" opacity="0.5" transform="translate(2 3)">
      <rect x="1" y="1" width="4" height="2" rx="1"/><circle cx="8" cy="8" r="3" fill="none"/>
      <line x1="0" y1="0" x2="4" y2="4"/><polygon points="0,0 4,0 2,3" fill-rule="evenodd"/>
    </g>
    <defs><path d="M9 9h1"/></defs><title>ignored</title>
  </svg>`);
  const svg = extractSvg(document.querySelector("svg"), "rgba(1, 2, 3, 1)");
  expect(svg.viewBox).toEqual([0, 0, 16, 16]);
  expect(svg.width).toBe(16);
  expect(svg.shapes.map((shape) => [shape.fill, shape.stroke])).toEqual([
    ["rgba(1, 2, 3, 1)", null],
    ["rgba(255, 0, 0, 1)", "rgba(0, 0, 255, 1)"],
    [null, "rgba(0, 0, 255, 1)"],
    [null, "rgba(0, 0, 255, 1)"],
    ["rgba(255, 0, 0, 1)", "rgba(0, 0, 255, 1)"],
  ]);
  const [, rect, circle, , polygon] = svg.shapes;
  expect(rect.d).toStartWith("M2 1");
  expect(rect).toMatchObject({ strokeWidth: 2, fillOpacity: 0.5, strokeOpacity: 0.5, matrix: [1, 0, 0, 1, 2, 3] });
  expect(circle.d).toBe("M5 8a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z");
  expect(polygon).toMatchObject({ d: "M0 0L4 0L2 3Z", fillRule: "evenodd" });
  window.happyDOM.abort();
});

test("parses transform lists into one matrix", () => {
  expect(parseTransform("translate(10 20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
  const [a, b, c, d] = parseTransform("rotate(90)");
  expect([a, b, c, d].map((value) => Math.round(value))).toEqual([0, 1, -1, 0]);
});

test("SVG paint follows the CSS cascade, inherited HTML fill and descendant currentColor", () => {
  const { document, window } = parseHTMLDocument(`<main style="fill:green;color:blue"><svg viewBox="0 0 24 24" style="opacity:.5">
    <path id="inherited" d="M0 0h3v3z"/>
    <path id="overridden" fill="red" stroke-width="1" d="M4 0h3v3z"/>
    <g style="color:red;fill:currentColor;opacity:.5"><path d="M8 0h3v3z"/></g>
    <path id="inline" fill="red" style="fill:yellow" d="M12 0h3v3z"/>
  </svg></main>`);
  const styles = new StyleEngine().compute(document, ["#overridden {fill:blue;stroke:currentColor;stroke-width:2;fill-opacity:50%;fill-rule:evenodd}"]);
  const tree = new RenderTreeBuilder().build(document, styles);
  const svg = [...tree.nodesById.values()].find(node => node.tagName === "SVG").svg;
  expect(svg.shapes.map(shape => shape.fill)).toEqual([
    "rgba(0, 128, 0, 1)", "rgba(0, 0, 255, 1)", "rgba(255, 0, 0, 1)", "rgba(255, 255, 0, 1)",
  ]);
  expect(svg.shapes[1]).toMatchObject({ stroke: "rgba(0, 0, 255, 1)", strokeWidth: 2, fillOpacity: .5, fillRule: "evenodd" });
  expect(svg.shapes[0].fillOpacity).toBe(1); // Root opacity is applied by its CSS box, once.
  expect(svg.shapes[2].fillOpacity).toBe(.5);
  window.happyDOM.abort();
});

test("SVG CSS display removes a subtree while visible descendants can override visibility", () => {
  const { document, window } = parseHTMLDocument(`<svg><g class="hidden"><path d="M0 0h3v3z"/><path class="visible" d="M4 0h3v3z"/></g>
    <g class="none"><path class="visible" d="M8 0h3v3z"/></g></svg>`);
  const styles = new StyleEngine().compute(document, [".hidden {visibility:hidden}.visible{visibility:visible}.none{display:none}"]);
  const svg = extractSvg(document.querySelector("svg"), "black", styles);
  expect(svg.shapes).toHaveLength(1);
  expect(svg.shapes[0].d).toBe("M4 0h3v3z");
  window.happyDOM.abort();
});

test("inline SVG is a replaced box with margins and vertical-align in the line", () => {
  const { document, window } = parseHTMLDocument(`<body style="margin:0"><p style="margin:0">
    <svg viewBox="0 0 16 16" width="16" height="16" style="margin-right:8px;vertical-align:text-bottom"><path d="M0 0h16v16z"/></svg>Readme</p></body>`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, {
    x: 0, y: 0, width: 300, measureText: (text) => text.length * 10, fontMetrics: () => ({ ascent: 16, height: 20 }),
  });
  const runs = layout.fragments.flatMap((fragment) => fragment.runs);
  const icon = runs.find((run) => run.type === "image");
  const text = runs.find((run) => run.text?.includes("Readme"));
  expect(icon).toMatchObject({ x: 0, width: 16, height: 16 });
  // margin-right separates the icon from the text.
  expect(text.x).toBeGreaterThanOrEqual(24);
  // text-bottom: the icon's bottom sits on the text's bottom (baseline 16 + descent 4).
  expect(icon.y + icon.height).toBe(20);
  const items = buildDisplayList(layout, tree).items;
  expect(items.find((item) => item.op === "drawSvg")).toMatchObject({ rect: { x: 0, width: 16, height: 16 } });
  window.happyDOM.abort();
});

test("unchanged SVG nodes and their containers survive unrelated content edits", () => {
  const { document, window } = parseHTMLDocument(`<main><section><svg viewBox="0 0 24 24" width="24" height="24">
    <g transform="translate(2 3)"><path d="M0 0h4v4z" fill="currentColor"/></g>
  </svg></section><p>before</p></main>`);
  try {
    const styles = new StyleEngine().compute(document), builder = new RenderTreeBuilder();
    const before = builder.build(document, styles);
    expect(builder.build(document, styles).root).toBe(before.root);
    document.querySelector("p").firstChild.data = "after";
    const after = builder.build(document, styles);
    for (const node of before.nodesById.values()) if (["SVG", "SECTION"].includes(node.tagName)) {
      expect(after.nodesById.get(node.id)).toBe(node);
    }
    expect(after.root).not.toBe(before.root);
  } finally { window.happyDOM.abort(); }
});

test("SVG reuse compares transform numbers exactly, including overflow", () => {
  const { document, window } = parseHTMLDocument(`<svg width="24" height="24">
    <g transform="scale(1e308) scale(1e308)"><path d="M0 0h4v4z"/></g></svg>`);
  try {
    const styles = new StyleEngine().compute(document), builder = new RenderTreeBuilder();
    const icon = tree => [...tree.nodesById.values()].find(node => node.tagName === "SVG");
    const before = icon(builder.build(document, styles));
    document.querySelector("g").setAttribute("transform", "scale(1e308) scale(-1e308)");
    const after = icon(builder.build(document, styles));
    // JSON turns both infinities and NaN into null; those are not equal
    // extracted matrices, even though their JSON representations coincide.
    expect(JSON.stringify(after.svg)).toBe(JSON.stringify(before.svg));
    expect(after).not.toBe(before);
    expect(before.svg.shapes[0].matrix[0]).toBe(Infinity);
    expect(after.svg.shapes[0].matrix[0]).toBe(-Infinity);
    expect(icon(builder.build(document, styles))).toBe(after);
  } finally { window.happyDOM.abort(); }
});

test("retained SVG layout and edited SVG paint match fresh renderer pixels", async () => {
  const result = Bun.spawnSync([process.execPath, new URL("fixtures/svg-node-reuse.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain("SVG node reuse renderer oracle passed");
}, 60_000);

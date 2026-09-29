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

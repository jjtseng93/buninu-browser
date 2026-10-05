/**
 * Inline SVG as a replaced element: the <svg> subtree is turned into a list
 * of shapes (SVG path data plus paint) in the viewBox coordinate system,
 * which the painter draws scaled into the element's box.
 *
 * Supported: path, rect, circle, ellipse, line, polyline, polygon, nested g
 * and svg; fill, stroke, stroke-width, fill-rule, opacity, fill-opacity,
 * stroke-opacity and transform (matrix, translate, scale, rotate) from
 * attributes, inherited through groups; currentColor. Text, gradients,
 * patterns, masks, filters and <use> are not drawn.
 */

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const SKIPPED = new Set(["defs", "clippath", "mask", "pattern", "symbol", "lineargradient", "radialgradient", "filter", "title", "desc", "metadata", "style", "script"]);
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/**
 * @param {Element} element the <svg> element
 * @param {string} currentColor the element's computed color (rgba)
 * @returns {{ viewBox: number[] | null, width: number | null, height: number | null, shapes: object[] }}
 */
export function extractSvg(element, currentColor) {
  // HTML-parsed markup may carry the attribute lowercased (viewbox).
  const viewBox = parseNumbers(element.getAttribute("viewBox") ?? element.getAttribute("viewbox"));
  const shapes = [];
  const root = {
    fill: "rgba(0, 0, 0, 1)",
    stroke: null,
    strokeWidth: 1,
    fillRule: "nonzero",
    fillOpacity: 1,
    strokeOpacity: 1,
    opacity: 1,
    matrix: IDENTITY,
  };
  walk(element, inherit(root, element, currentColor, true));

  function walk(node, paint) {
    for (const child of node.children ?? []) {
      const name = child.localName?.toLowerCase();
      if (!name || SKIPPED.has(name) || child.getAttribute("display") === "none" || child.getAttribute("visibility") === "hidden") continue;
      const childPaint = inherit(paint, child, currentColor, false);
      if (name === "g" || name === "svg" || name === "a") {
        walk(child, childPaint);
        continue;
      }
      if (!SHAPES.has(name)) continue;
      const d = shapePath(name, child);
      if (!d) continue;
      // A line has no interior to fill (SVG 2 §10.5).
      const fill = name === "line" ? null : childPaint.fill;
      if (!fill && !childPaint.stroke) continue;
      shapes.push(Object.freeze({
        d,
        fill,
        stroke: childPaint.stroke,
        strokeWidth: childPaint.strokeWidth,
        fillRule: childPaint.fillRule,
        fillOpacity: childPaint.fillOpacity * childPaint.opacity,
        strokeOpacity: childPaint.strokeOpacity * childPaint.opacity,
        matrix: childPaint.matrix,
      }));
    }
  }

  return Object.freeze({
    viewBox: viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? Object.freeze(viewBox) : null,
    width: length(element.getAttribute("width")),
    height: length(element.getAttribute("height")),
    shapes: Object.freeze(shapes),
  });
}

/** Paint properties of `element`, inheriting from `parent`. Opacity multiplies down the tree. */
function inherit(parent, element, currentColor, isRoot) {
  const attribute = (name) => {
    // Presentation attributes, overridden by the style attribute.
    const style = element.getAttribute("style") ?? "";
    const fromStyle = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style)?.[1]?.trim();
    return fromStyle ?? element.getAttribute(name);
  };
  const paint = { ...parent };
  const fill = attribute("fill");
  if (fill != null && fill !== "inherit") paint.fill = color(fill, currentColor);
  const stroke = attribute("stroke");
  if (stroke != null && stroke !== "inherit") paint.stroke = color(stroke, currentColor);
  const strokeWidth = length(attribute("stroke-width"));
  if (strokeWidth != null) paint.strokeWidth = strokeWidth;
  const fillRule = attribute("fill-rule");
  if (fillRule === "evenodd" || fillRule === "nonzero") paint.fillRule = fillRule;
  const number = (name) => {
    const value = Number.parseFloat(attribute(name));
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  };
  paint.fillOpacity = number("fill-opacity") ?? parent.fillOpacity;
  paint.strokeOpacity = number("stroke-opacity") ?? parent.strokeOpacity;
  paint.opacity = parent.opacity * (number("opacity") ?? 1);
  // The root's own transform does not apply (it is a CSS box), its children's do.
  const transform = isRoot ? null : element.getAttribute("transform");
  if (transform) paint.matrix = multiply(parent.matrix, parseTransform(transform));
  return paint;
}

function color(value, currentColor) {
  const text = String(value).trim();
  if (text === "none" || text.startsWith("url(")) return null;
  if (text.toLowerCase() === "currentcolor") return currentColor;
  return Bun.color(text, "rgba") ?? null;
}

function length(value) {
  if (value == null) return null;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(String(value));
  return match ? Number(match[1]) : null;
}

function parseNumbers(value) {
  return String(value ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

/** SVG path data for a basic shape (SVG 2 §10). */
function shapePath(name, element) {
  const number = (attribute) => length(element.getAttribute(attribute)) ?? 0;
  switch (name) {
    case "path":
      return element.getAttribute("d")?.trim() || null;
    case "rect": {
      const [x, y, width, height] = [number("x"), number("y"), number("width"), number("height")];
      if (width <= 0 || height <= 0) return null;
      let rx = length(element.getAttribute("rx"));
      let ry = length(element.getAttribute("ry"));
      rx ??= ry ?? 0;
      ry ??= rx;
      rx = Math.min(rx, width / 2);
      ry = Math.min(ry, height / 2);
      if (rx <= 0 || ry <= 0) return `M${x} ${y}h${width}v${height}h${-width}Z`;
      return `M${x + rx} ${y}h${width - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${height - 2 * ry}`
        + `a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${-(width - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}`
        + `v${-(height - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}Z`;
    }
    case "circle":
    case "ellipse": {
      const [cx, cy] = [number("cx"), number("cy")];
      const rx = name === "circle" ? number("r") : number("rx");
      const ry = name === "circle" ? rx : number("ry");
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "line":
      return `M${number("x1")} ${number("y1")}L${number("x2")} ${number("y2")}`;
    case "polyline":
    case "polygon": {
      const points = parseNumbers(element.getAttribute("points"));
      if (points.length < 4) return null;
      let d = `M${points[0]} ${points[1]}`;
      for (let index = 2; index + 1 < points.length; index += 2) d += `L${points[index]} ${points[index + 1]}`;
      return name === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/** A transform list as an [a, b, c, d, e, f] matrix (SVG 2 §8.5). */
export function parseTransform(text) {
  let matrix = IDENTITY;
  for (const match of String(text).matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi)) {
    const args = parseNumbers(match[2]);
    let next = null;
    switch (match[1].toLowerCase()) {
      case "matrix":
        if (args.length === 6) next = args;
        break;
      case "translate":
        next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case "scale":
        next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const angle = (args[0] ?? 0) * Math.PI / 180;
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
        const rotation = [cos, sin, -sin, cos, 0, 0];
        const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
        next = cx || cy
          ? multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy])
          : rotation;
        break;
      }
      case "skewx":
        next = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
        break;
      case "skewy":
        next = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
        break;
    }
    if (next) matrix = multiply(matrix, next);
  }
  return matrix;
}

function multiply([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) {
  return Object.freeze([
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]);
}

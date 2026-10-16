const FIELDS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"];
const SQUARE = Object.freeze({ x: 0, y: 0 });

/** Clockwise corner pairs, starting at the top left. */
export function radiusPairs(radii) {
  return radii?.corners ?? Array.from({ length: 4 }, () => [radii?.x ?? 0, radii?.y ?? 0]);
}

function compact(pairs) {
  const [x, y] = pairs[0];
  return pairs.every(pair => pair[0] === x && pair[1] === y) ? { x, y }
    : { x: Math.max(...pairs.map(pair => pair[0])), y: Math.max(...pairs.map(pair => pair[1])), corners: pairs };
}

export function mapRadii(radii, map) {
  return compact(radiusPairs(radii).map(([x, y], index) => map(x, y, index)));
}

export function insetRadii(radii, [top, right, bottom, left]) {
  if (!radii || !(radii.x > 0 || radii.y > 0)) return SQUARE;
  const horizontal = [left, right, right, left], vertical = [top, top, bottom, bottom];
  return mapRadii(radii, (x, y, index) => [Math.max(0, x - horizontal[index]),
    Math.max(0, y - vertical[index])]);
}

export function scaleRadii(radii, x, y) {
  let pairs = radiusPairs(radii).map(pair => [pair[0] * Math.abs(x), pair[1] * Math.abs(y)]);
  if (x < 0) pairs = [pairs[1], pairs[0], pairs[3], pairs[2]];
  if (y < 0) pairs = [pairs[3], pairs[2], pairs[1], pairs[0]];
  return compact(pairs);
}

/** CanvasKit's twelve-float rounded rectangle, with independent elliptic corners. */
export function roundedRect(rect, radii, scale = 1) {
  const result = new Float32Array(12);
  result.set(rect);
  if (!radii?.corners) {
    const x = (radii?.x ?? 0) * scale, y = (radii?.y ?? 0) * scale;
    for (let i = 4; i < 12; i += 2) { result[i] = x; result[i + 1] = y; }
    return result;
  }
  const pairs = radii.corners;
  for (let i = 0; i < 4; i++) {
    result[4 + i * 2] = pairs[i][0] * scale;
    result[5 + i * 2] = pairs[i][1] * scale;
  }
  return result;
}

/** CSS Backgrounds §5.5: all radii share one overlap-reduction factor. */
export function resolveCornerRadii(style, rect) {
  const first = style?.[FIELDS[0]];
  if (first && FIELDS.every(field => style[field] === first)) {
    const x = Math.max(0, length(first[0], rect.width));
    const y = Math.max(0, length(first[1], rect.height));
    if (!(x > 0 || y > 0)) return SQUARE;
    const factor = Math.min(1, ratio(rect.width, x * 2), ratio(rect.height, y * 2));
    return { x: x * factor, y: y * factor };
  }
  const pairs = FIELDS.map(field => {
    const [x, y] = style?.[field] ?? [style?.borderRadius ?? 0, style?.borderRadius ?? 0];
    return [Math.max(0, length(x, rect.width)), Math.max(0, length(y, rect.height))];
  });
  const [tl, tr, br, bl] = pairs;
  const factor = Math.min(1, ratio(rect.width, tl[0] + tr[0]), ratio(rect.width, bl[0] + br[0]),
    ratio(rect.height, tl[1] + bl[1]), ratio(rect.height, tr[1] + br[1]));
  return compact(pairs.map(pair => pair.map(value => value * factor)));
}

const ratio = (size, sum) => sum > 0 ? Math.max(0, size) / sum : 1;
function length(value, reference) {
  if (typeof value === "number") return value;
  if (value?.unit === "%") return reference * value.value / 100;
  if (value?.unit === "math") {
    if (value.kind === "calc") return value.px + reference * value.percent / 100;
    const values = value.values.map(part => length(part, reference));
    if (value.kind === "min") return Math.min(...values);
    if (value.kind === "max") return Math.max(...values);
    if (value.kind === "clamp") return Math.max(values[0], Math.min(values[1], values[2]));
  }
  return 0;
}

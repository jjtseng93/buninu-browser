/**
 * Resolves CSS gradient images against a background positioning area.
 *
 * Geometry follows CSS Images 3: the linear gradient line length for angle A
 * in a W×H box is |W·sinA| + |H·cosA|, "to <corner>" angles make the 50%
 * line pass through the other two corners, and radial sizes default to
 * farthest-corner. Results are plain data for the display list; the
 * rasterizer turns them into CanvasKit shaders.
 */
const SIDES = Object.freeze({ top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] });

/** Splits a `background-image` value into its layers (images, gradients or none), topmost first. */
export function backgroundLayers(value) {
  return value ? splitTopLevel(String(value), ",") : [];
}

export function isGradient(layer) {
  return /^(?:repeating-)?(?:linear|radial)-gradient\(/i.test(layer);
}

/** Splits a `background`/`background-image` value into gradient layers, topmost first. */
export function gradientLayers(value) {
  return backgroundLayers(value).filter(isGradient);
}

export function resolveGradient(source, rect, fontSize = 16) {
  const match = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/is.exec(source.trim());
  if (!match) return null;
  const args = splitTopLevel(match[3], ",").map((part) => part.trim()).filter(Boolean);
  if (!args.length) return null;
  return match[2].toLowerCase() === "linear"
    ? linearGradient(args, rect, fontSize, Boolean(match[1]))
    : radialGradient(args, rect, fontSize, Boolean(match[1]));
}

function linearGradient(args, rect, fontSize, repeating) {
  let angle = Math.PI;
  const first = args[0].toLowerCase();
  const parsedAngle = parseAngle(first);
  if (parsedAngle != null) {
    angle = parsedAngle;
    args = args.slice(1);
  } else if (first.startsWith("to ")) {
    let dx = 0;
    let dy = 0;
    for (const word of first.slice(3).trim().split(/\s+/)) {
      const side = SIDES[word];
      if (!side) return null;
      dx += side[0];
      dy += side[1];
    }
    // Corners: perpendicular to the diagonal that joins the other two corners.
    angle = dx && dy ? Math.atan2(dx * rect.height, -dy * rect.width) : Math.atan2(dx, -dy);
    args = args.slice(1);
  }
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const length = Math.abs(rect.width * sin) + Math.abs(rect.height * cos);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const stops = colorStops(args, length, fontSize);
  if (!stops) return null;
  return {
    type: "linear",
    x0: centerX - sin * length / 2,
    y0: centerY + cos * length / 2,
    x1: centerX + sin * length / 2,
    y1: centerY - cos * length / 2,
    stops,
    repeating,
  };
}

function radialGradient(args, rect, fontSize, repeating) {
  let shape = "ellipse";
  let size = "farthest-corner";
  let explicit = null;
  let position = ["50%", "50%"];
  const first = args[0].toLowerCase();
  const isColor = (text) => Bun.color(text.split(/\s+/)[0], "rgba") != null;
  if (!isColor(first)) {
    const [shapePart, positionPart] = first.split(/\s*\bat\b\s*/);
    const words = shapePart.trim() ? shapePart.trim().split(/\s+/) : [];
    const lengths = [];
    for (const word of words) {
      if (word === "circle" || word === "ellipse") shape = word;
      else if (/^(?:closest|farthest)-(?:side|corner)$/.test(word)) size = word;
      else lengths.push(word);
    }
    if (lengths.length) {
      if (lengths.length === 1) shape = "circle";
      explicit = lengths.map((length, index) =>
        resolveLength(length, index === 0 ? rect.width : rect.height, fontSize));
      if (explicit.some((value) => !Number.isFinite(value))) return null;
    }
    if (positionPart) position = positionTokens(positionPart);
    args = args.slice(1);
  }
  const cx = rect.x + resolvePosition(position[0], rect.width, fontSize, "x");
  const cy = rect.y + resolvePosition(position[1], rect.height, fontSize, "y");
  let rx;
  let ry;
  if (explicit) {
    [rx, ry = rx] = explicit;
  } else {
    const distancesX = [Math.abs(cx - rect.x), Math.abs(rect.x + rect.width - cx)];
    const distancesY = [Math.abs(cy - rect.y), Math.abs(rect.y + rect.height - cy)];
    const pickSide = size.startsWith("closest") ? Math.min : Math.max;
    const sideX = pickSide(...distancesX);
    const sideY = pickSide(...distancesY);
    if (shape === "circle") {
      rx = size.endsWith("side") ? pickSide(sideX, sideY) : Math.hypot(sideX, sideY);
      ry = rx;
    } else if (size.endsWith("side")) {
      [rx, ry] = [sideX, sideY];
    } else {
      // Corner sizes keep the side sizes' aspect ratio and pass through the corner.
      [rx, ry] = [sideX * Math.SQRT2, sideY * Math.SQRT2];
    }
  }
  if (!(rx > 0) || !(ry > 0)) return null;
  const stops = colorStops(args, rx, fontSize);
  if (!stops) return null;
  return { type: "radial", cx, cy, rx, ry, stops, repeating };
}

/** Resolves color stops to offsets in [0, 1] along a gradient ray of `length` px. */
function colorStops(args, length, fontSize) {
  const stops = [];
  for (const arg of args) {
    const parts = splitTopLevel(arg, " ").filter(Boolean);
    const color = Bun.color(parts[0], "rgba");
    if (!color) return null;
    const positions = parts.slice(1).map((part) => resolveLength(part, length, fontSize) / length);
    if (positions.some((value) => !Number.isFinite(value))) return null;
    if (!positions.length) stops.push({ color, offset: null });
    for (const offset of positions) stops.push({ color, offset });
  }
  if (stops.length < 2) {
    if (stops.length === 1) stops.push({ ...stops[0] });
    else return null;
  }
  // CSS Images 3 §3.4.3: default the ends, keep positions monotonic, then
  // spread unpositioned stops evenly between their positioned neighbours.
  stops[0].offset ??= 0;
  stops.at(-1).offset ??= 1;
  let previous = stops[0].offset;
  for (const stop of stops) {
    if (stop.offset != null) previous = stop.offset = Math.max(stop.offset, previous);
  }
  for (let index = 1; index < stops.length; index++) {
    if (stops[index].offset != null) continue;
    let next = index;
    while (stops[next].offset == null) next++;
    const start = stops[index - 1].offset;
    const step = (stops[next].offset - start) / (next - index + 1);
    for (let fill = index; fill < next; fill++) stops[fill].offset = start + step * (fill - index + 1);
  }
  return stops.map((stop) => ({ color: stop.color, offset: stop.offset }));
}

function parseAngle(text) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return { deg: value * Math.PI / 180, grad: value * Math.PI / 200, rad: value, turn: value * Math.PI * 2 }[match[2]];
}

function positionTokens(text) {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) {
    const word = words[0];
    return ["top", "bottom"].includes(word) ? ["50%", word] : [word, "50%"];
  }
  // Keywords may appear in either order ("top left").
  if (["top", "bottom"].includes(words[0]) || ["left", "right"].includes(words[1])) return [words[1], words[0]];
  return [words[0], words[1]];
}

function resolvePosition(token, extent, fontSize, axis) {
  const keyword = { left: 0, top: 0, center: 50, right: 100, bottom: 100 }[token];
  if (keyword != null) return extent * keyword / 100;
  const value = resolveLength(token, extent, fontSize);
  return Number.isFinite(value) ? value : extent / 2;
}

function resolveLength(text, reference, fontSize) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%|em|rem)?$/.exec(String(text).trim());
  if (!match) return NaN;
  const value = Number(match[1]);
  if (match[2] === "%") return reference * value / 100;
  if (match[2] === "em") return value * fontSize;
  if (match[2] === "rem") return value * 16;
  if (!match[2] && value !== 0) return NaN;
  return value;
}

export function splitTopLevel(source, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") depth++;
    else if (character === ")") depth--;
    else if (depth === 0 && (separator === " " ? /\s/.test(character) : character === separator)) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

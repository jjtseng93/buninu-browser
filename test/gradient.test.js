import { expect, test } from "bun:test";
import { gradientLayers, resolveGradient } from "../lib/paint/gradient.js";

const RECT = { x: 10, y: 20, width: 200, height: 100 };

test("resolves linear gradient lines from angles and side keywords", () => {
  // 90deg: left to right across the box width.
  expect(resolveGradient("linear-gradient(90deg, red, blue)", RECT)).toMatchObject({
    type: "linear", x0: 10, y0: 70, x1: 210, y1: 70,
    stops: [{ color: "rgba(255, 0, 0, 1)", offset: 0 }, { color: "rgba(0, 0, 255, 1)", offset: 1 }],
  });
  // Default is "to bottom".
  const down = resolveGradient("linear-gradient(red, blue)", RECT);
  expect([down.x0, down.y0, down.x1, down.y1].map((value) => Math.round(value))).toEqual([110, 20, 110, 120]);
  // 180deg matches the default; the gradient line length is |W sinA| + |H cosA|.
  const angled = resolveGradient("linear-gradient(0.5turn, red, blue)", RECT);
  expect(Math.round(angled.y1 - angled.y0)).toBe(100);
});

test("makes corner gradients pass through the other two corners", () => {
  // "to top right": direction ⟂ to the top-left/bottom-right diagonal, i.e. (H, -W).
  const gradient = resolveGradient("linear-gradient(to top right, red, blue)", RECT);
  const direction = [gradient.x1 - gradient.x0, gradient.y1 - gradient.y0];
  expect(direction[0] * 200 + direction[1] * 100).toBeCloseTo(0);
  expect(direction[0]).toBeGreaterThan(0);
  expect(direction[1]).toBeLessThan(0);
});

test("fills in unpositioned color stops and keeps positions monotonic", () => {
  const gradient = resolveGradient("linear-gradient(90deg, red, lime 20%, blue, black 10%, white)", RECT);
  expect(gradient.stops.map((stop) => stop.offset)).toEqual([0, 0.2, 0.2, 0.2, 1]);
  const spread = resolveGradient("linear-gradient(90deg, red, lime, blue)", RECT);
  expect(spread.stops.map((stop) => stop.offset)).toEqual([0, 0.5, 1]);
});

test("resolves radial gradient sizes and positions", () => {
  // The buninu.org hero glow: explicit ellipse radii at 50% -10%.
  const hero = resolveGradient(
    "radial-gradient(1200px 500px at 50% -10%, rgba(255, 183, 3, .16), transparent 60%)", RECT);
  expect(hero).toMatchObject({ type: "radial", cx: 110, cy: 10, rx: 1200, ry: 500 });
  expect(hero.stops.map((stop) => stop.offset)).toEqual([0, 0.6]);
  // farthest-corner ellipse keeps the farthest-side ratio: √2 × (100, 50).
  const corner = resolveGradient("radial-gradient(red, blue)", RECT);
  expect(corner.rx).toBeCloseTo(100 * Math.SQRT2);
  expect(corner.ry).toBeCloseTo(50 * Math.SQRT2);
  // closest-side circle at (50, 50) inside the box: nearest sides are 50px away.
  expect(resolveGradient("radial-gradient(circle closest-side at 25% 50%, red, blue)", RECT)).toMatchObject({
    cx: 60, cy: 70, rx: 50, ry: 50,
  });
});

test("splits background layers and rejects unsupported values", () => {
  expect(gradientLayers("radial-gradient(red, blue), linear-gradient(180deg, #000 0%, #fff 70%)")).toHaveLength(2);
  expect(resolveGradient("conic-gradient(red, blue)", RECT)).toBeNull();
  expect(resolveGradient("linear-gradient(90deg, notacolor, blue)", RECT)).toBeNull();
});

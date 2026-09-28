import { expect, test } from "bun:test";
import { ScrollViewport } from "../lib/layout/scroll-viewport.js";

test("scroll viewport clamps offsets to content bounds", () => {
  const viewport = new ScrollViewport(320, 200);
  viewport.setContentSize(500, 900);

  expect(viewport.scrollBy(20, 100)).toBeTrue();
  expect({ x: viewport.x, y: viewport.y }).toEqual({ x: 20, y: 100 });
  viewport.scrollBy(1_000, 1_000);
  expect({ x: viewport.x, y: viewport.y }).toEqual({ x: 180, y: 700 });
  viewport.scrollBy(-1_000, -1_000);
  expect({ x: viewport.x, y: viewport.y }).toEqual({ x: 0, y: 0 });
});

test("resize and content changes keep the current offset valid", () => {
  const viewport = new ScrollViewport(100, 100);
  viewport.setContentSize(100, 500);
  viewport.scrollTo(0, 400);
  viewport.resize(100, 300);
  expect(viewport.y).toBe(200);
  viewport.setContentSize(100, 50);
  expect(viewport.y).toBe(0);
});


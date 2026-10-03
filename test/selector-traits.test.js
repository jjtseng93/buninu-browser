import { expect, test } from "bun:test";
import { sheetTraits } from "../lib/style/selector-traits.js";

test("finds :has() compounds and sibling-target compounds in a sheet", () => {
  const traits = sheetTraits(`
    /* .ignored:has(a) {} */
    .a:has(> img), .b .c:has(+ .d)::before { color: red }
    @media (min-width: 1px) { .e { color: blue } }
    .f:has(.g) .h, .i { color: green }
    li:first-child + li .x, ul > li:last-child ~ li { color: black }
    .esc\\:a .y:not([data-z="a b"]) { color: white }
  `);
  expect([...traits.hasCompounds]).toEqual([".a:has(> img)", ".c:has(+ .d)", ".f:has(.g)"]);
  expect(traits.hasSiblings).toBe(true);
  expect([...traits.siblingTargetCompounds]).toEqual(["li:first-child + li"]);
  expect([...traits.structuralCompounds]).toEqual(["li:first-child", "li:last-child"]);
  expect(traits.descendantFeatures.has(".esc:a")).toBe(true);
  expect(traits.sibling && traits.firstChild && traits.lastChild).toBe(true);
});

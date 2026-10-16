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

test("focus pseudo-class features retain their complete names", () => {
  const traits = sheetTraits('.a:focus .x{}.b:focus-visible .x{}.c:focus-within .x{}');
  expect(traits.descendantStateCompounds.map(entry=>entry.states)).toEqual([[":focus"],[":focus-visible"],[":focus-within"]]);
});

test("nested rule groups retain their first selector's invalidation dependencies", () => {
  const traits=sheetTraits('@media(min-width:1px){@layer app{.panel:focus-within .label{color:red}.panel:has([data-open]){color:blue}}}');
  expect(traits.descendantStateCompounds.map(entry=>entry.states)).toEqual([[":focus-within"]]);
  expect([...traits.hasCompounds]).toEqual(['.panel:has([data-open])']);
  expect(traits.descendantFeatures.has('.panel')).toBe(true);
});

test("functional alternatives constrain state invalidation without assuming negated requirements", () => {
  const traits = sheetTraits(':is(.a,.b):focus-within .x{}:where(.outer > .target,button):focus .x{}:not(:is(.a,.b)):focus .x{}');
  expect(traits.descendantStateCompounds.map(entry=>entry.alternatives))
    .toEqual([[[[".a"],[".b"]]],[[[".target"],["t:button"]]],[]]);
});

test("observed attributes include nested, subject and escaped selectors", () => {
  const traits = sheetTraits(String.raw`@media (min-width:1px){[data-open] .x:has([aria-expanded="true"]){} }
    :is([title],[data-foo\:bar]){}.x[DATA-STATE]{}[ns|data-mode]{}[|data-empty]{}[data\2d escaped]{}`);
  expect([...traits.observedAttributes].sort()).toEqual(["aria-expanded","data-empty","data-escaped","data-foo:bar","data-mode","data-open","data-state","title"]);
});

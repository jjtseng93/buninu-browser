import { expect, test } from "bun:test";
import { selectorKeys } from "../lib/style/selector-keys.js";

test("indexes a selector by its subject's first key and its ancestors' keys", () => {
  expect(selectorKeys("DIV.Foo > SPAN#Bar.baz[Data-X]")).toEqual({
    subject: [{ kind: "id", name: "Bar" }],
    ancestors: ["div", ".Foo"],
  });
  // Sibling compounds are not ancestors; attribute and type names are lowercased.
  expect(selectorKeys("ul [Role] + LI:hover")).toEqual({ subject: [{ kind: "tag", name: "li" }], ancestors: ["ul"] });
  // :root is the "html" bucket as a subject, but not an ancestor filter key.
  expect(selectorKeys(":root").subject).toEqual([{ kind: "tag", name: "html" }]);
  expect(selectorKeys(":ROOT .x")).toEqual({ subject: [{ kind: "class", name: "x" }], ancestors: [] });
});

test("escapes, quotes and digits in names", () => {
  expect(selectorKeys(".a\\:hover .b\\.c").ancestors).toEqual([".a:hover"]);
  expect(selectorKeys(".a\\:hover .b\\.c").subject).toEqual([{ kind: "class", name: "b.c" }]);
  // A hex escape cannot be resolved here: the name is left out.
  expect(selectorKeys(".\\31 0").subject).toBeNull();
  // Class names cannot start with a digit; ids can.
  expect(selectorKeys(".1a").subject).toBeNull();
  expect(selectorKeys("#1a").subject).toEqual([{ kind: "id", name: "1a" }]);
  // Brackets and "." inside a quoted attribute value are not structure.
  expect(selectorKeys('[data-x="a] .b"] .c')).toEqual({ subject: [{ kind: "class", name: "c" }], ancestors: ["[data-x"] });
  expect(selectorKeys(".日本 .語")).toEqual({ subject: [{ kind: "class", name: "語" }], ancestors: [".日本"] });
});

test(":is() and :where() alternatives each need a key; anything not understood is unindexed", () => {
  expect(selectorKeys(":is(.a, #b, p)").subject).toEqual([
    { kind: "class", name: "a" }, { kind: "id", name: "b" }, { kind: "tag", name: "p" },
  ]);
  expect(selectorKeys(":where(.a .b, .c)").subject).toBeNull();
  expect(selectorKeys(":is(.a, :not(.b))").subject).toBeNull();
  expect(selectorKeys("ns|a b").ancestors).toEqual([]);
  for (const selector of ["", "> a", "a >", "a 'unterminated", ":is(.a"]) {
    expect(selectorKeys(selector)).toEqual({ subject: null, ancestors: [] });
  }
});

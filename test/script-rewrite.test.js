import { expect, test } from "bun:test";
import { escapeSesHtmlComments, rewriteConstructorReads } from "../lib/renderer/script-rewrite.js";

const rewrite = (source, type) => rewriteConstructorReads(source, type).code;

test("HTML comment markers in JavaScript values are escaped without changing them", () => {
  const source = 'const a = "<!-- start -->"; const b = /-->/g; const c = `<!-- ${1} -->`;';
  const escaped = escapeSesHtmlComments(source);
  expect(escaped).not.toContain("<!--");
  expect(escaped).not.toContain("-->");
  expect(Function(`${escaped}; return [a, b.test('-->'), c]`)()).toEqual(["<!-- start -->", true, "<!-- 1 -->"]);
});

test("constructor reads go through the helper; writes, delete and optional chains do not", () => {
  expect(rewrite("var A = Object.getPrototypeOf(async function () {}).constructor;"))
    .toBe("var A = $buninu$constructor(Object.getPrototypeOf(async function () {}));");
  // Parentheses around the object stay; nested reads compose.
  expect(rewrite("x = (async () => {}).constructor.constructor;"))
    .toBe("x = $buninu$constructor(($buninu$constructor(async () => {})));");
  // Once a source has the idiom, every read in it goes through the helper.
  const trigger = " (async () => {}).constructor;";
  expect(rewrite(`y = a . constructor ['constructor'];${trigger}`))
    .toBe("y = $buninu$constructor($buninu$constructor(a) ) ; ($buninu$constructor(async () => {}));");
  // Calls keep the receiver (the helper's second argument).
  // A constructed one is parenthesized so `new` applies to the result.
  expect(rewrite(`b.constructor(1); new c.constructor(); new d.constructor;${trigger}`))
    .toBe("$buninu$constructor(b, true)(1); new ($buninu$constructor(c))(); new ($buninu$constructor(d)); ($buninu$constructor(async () => {}));");
  const untouched = "a.constructor = 1; a.constructor++; delete a.constructor; for (a.constructor of []); c?.constructor; "
    + "class K extends B { constructor() { super(); super.constructor } } ({ constructor: 1 });";
  expect(rewrite(untouched + trigger)).toBe(`${untouched} ($buninu$constructor(async () => {}));`);
});

test("new on a rewritten constructor read constructs the object's constructor", () => {
  const code = rewrite("class Point { constructor(x) { this.x = x; } } const p = new Point(1);"
    + " result = new p.constructor(2); (async () => {}).constructor;");
  const run = new Function("$buninu$constructor", `let result; ${code} return result;`);
  const result = run((object) => object.constructor);
  expect(result).toBeObject();
  expect(result.constructor.name).toBe("Point");
  expect(result.x).toBe(2);
});

test("sources that cannot reach Function constructors are not parsed; bad syntax is left to the engine", () => {
  expect(rewriteConstructorReads("x.constructor.name")).toEqual({ code: "x.constructor.name", rewritten: false });
  // this.constructor is common and harmless; alone it does not trigger a parse.
  expect(rewriteConstructorReads("async function f() { return this.constructor }").rewritten).toBe(false);
  expect(rewriteConstructorReads("(async () => {}).constructor(")).toEqual({ code: "(async () => {}).constructor(", rewritten: false });
  expect(rewrite("export const A = (async () => {}).constructor;", "module"))
    .toBe("export const A = ($buninu$constructor(async () => {}));");
});

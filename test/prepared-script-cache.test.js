import { expect, test } from "bun:test";
import { PreparedScriptCache, prepareClassicScript } from "../lib/renderer/prepared-script-cache.js";
import { escapeSesHtmlComments, rewriteClassicScriptSource } from "../lib/renderer/script-rewrite.js";

test("cached preparation preserves source semantics and does not retain evaluated globals", () => {
  const source = "var result = supplied + 1; function read() { return result; }";
  const prepared = prepareClassicScript(source);
  const original = rewriteClassicScriptSource(source);
  expect(prepared).toEqual({ code: escapeSesHtmlComments(original.code), parsed: true, strict: false });
  expect(prepareClassicScript(source)).toBe(prepared);
  const run = supplied => {
    const page = { supplied, $buninu$ref: name => { throw new ReferenceError(name); } };
    page.globalThis = page;
    Function("page", "source", "with(page) { eval(source); }")(page, prepared.code);
    return page;
  };
  const first = run(2), second = run(8);
  expect(first.read()).toBe(3);
  expect(second.read()).toBe(9);
  expect(first.read).not.toBe(second.read);
  expect(Object.isFrozen(prepared)).toBeTrue();
});

test("preparation retains a bounded working set and never keeps oversized sources", () => {
  const calls = [];
  const cache = new PreparedScriptCache({ maxBytes: 40, maxEntries: 2, prepare(source) {
    calls.push(source); return { code: source, parsed: true, strict: false };
  } });
  cache.prepare("first"); cache.prepare("next"); cache.prepare("first"); cache.prepare("third");
  expect(calls).toEqual(["first", "next", "third"]);
  cache.prepare("next");
  expect(calls).toEqual(["first", "next", "third", "next"]);
  const oversized = "a".repeat(11);
  cache.prepare(oversized); cache.prepare(oversized);
  expect(calls.filter(source => source === oversized)).toHaveLength(2);
  expect(cache.prepare("next").code).toBe("next");
  expect(calls.filter(source => source === "next")).toHaveLength(2);
});

test("different strictness and invalid sources never share a prepared result", () => {
  const cache = new PreparedScriptCache();
  expect(cache.prepare("'use strict'; var value = 1;").strict).toBeTrue();
  expect(cache.prepare("var value = 1;").strict).toBeFalse();
  expect(cache.prepare("var = ;").parsed).toBeFalse();
});

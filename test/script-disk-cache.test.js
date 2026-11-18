import {expect, test} from "bun:test";
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prepareDiskCached} from "../lib/renderer/script-disk-cache.js";

test("disk preparation reuses code and flags across readers and distinguishes source and rewrite version", () => {
  const directory = mkdtempSync(join(tmpdir(), "script-cache-"));
  const calls = [];
  const compile = source => {
    calls.push(source);
    return {code:"result\ud800" + calls.length, strict:true, parsed:true};
  };
  const prepare = (text, version = "a") => prepareDiskCached(new TextEncoder().encode(text), directory, version, compile);
  try {
    const first = prepare("one");
    expect(prepare("one")).toEqual(first);
    expect(calls).toEqual(["one"]);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(directory, files[0]), "short");
    expect(prepare("one")).not.toEqual(first);
    prepare("two");
    prepare("one", "b");
    expect(calls).toEqual(["one", "one", "two", "one"]);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});

test("disk cache evicts old entries and treats an unwritable path as a miss", () => {
  const directory = mkdtempSync(join(tmpdir(), "script-cache-"));
  const compile = code => ({code, parsed:true, strict:false});
  const bytes = text => new TextEncoder().encode(text);
  try {
    for (const text of ["abc", "def", "ghi"]) prepareDiskCached(bytes(text), directory, "1", compile, 11);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const result = prepareDiskCached(bytes("abc"), join(directory, files[0], "invalid"), "1", compile);
    expect(result).toEqual(compile("abc"));
  } finally { rmSync(directory, {recursive:true, force:true}); }
});

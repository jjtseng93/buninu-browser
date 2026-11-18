import {expect, test} from "bun:test";
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
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

test("large preparations retain exact UTF-16 and share a disk budget across scripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "script-cache-"));
  let misses = 0;
  const code = "一\ud800a".repeat(65536);
  const prepare = text => prepareDiskCached(new TextEncoder().encode(text), directory, "v", source => {
    misses++;
    return {code:code + source, strict:false, parsed:true};
  }, 4096);
  try {
    for (const text of ["a", "b", "a", "b"]) {
      expect(prepare(text)).toEqual({code:code + text, strict:false, parsed:true});
    }
    expect(misses).toBe(2);
    // A damaged length must never allow inflation beyond the declared size.
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      const entry = readFileSync(file);
      entry.writeUInt32LE(1, 1);
      writeFileSync(file, entry);
    }
    expect(prepare("a").code).toBe(code + "a");
    expect(misses).toBe(3);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});

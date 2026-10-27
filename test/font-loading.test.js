import { expect, test } from "bun:test";
import { DocumentFonts, neededFontFaces } from "../lib/renderer/font-loading.js";
import { createPageRenderer, loadGraphics } from "../lib/renderer/page-renderer.js";

const face = (family, weight = 400, ranges = [[0, 0x10ffff]], extra = {}) => ({ family, weight: [weight, weight],
  style: "normal", unicodeRanges: ranges, sources: [{ url: `https://font.test/${family}-${weight}.ttf` }], ...extra });
const run = (text, fontFamily, fontWeight = 400, fontStyle = "normal") => ({ text, style: { fontFamily, fontWeight, fontStyle } });

test("font selection requests only used families, styles, weights, and Unicode subsets", () => {
  const latin = face("Example", 400, [[0, 127]]);
  const cjk = face("Example", 400, [[0x4e00, 0x9fff]]);
  const bold = face("Example", 700);
  const italic = face("Example", 400, [[0, 127]], { style: "italic" });
  const unused = face("Unused");
  const all = [latin, cjk, bold, italic, unused];
  expect([...neededFontFaces(all, [run("hello", ["Example", "Unused"])])]).toEqual([latin]);
  expect([...neededFontFaces(all, [run("中文", ["Example"])])]).toEqual([cjk]);
  expect([...neededFontFaces(all, [run("hello", ["Example"], 600)])]).toEqual([bold]);
  expect([...neededFontFaces(all, [run("hello", ["Example"], 400, "italic")])]).toEqual([italic]);
  expect([...neededFontFaces(all, [run("hello", ["system-ui", "Unused"])], new Set(["system-ui"]))]).toEqual([]);
  const earlier = face("Later");
  const later = face("Later");
  expect([...neededFontFaces([earlier, later], [run("hello", ["Later"])])][0]).toBe(later);
});

test("document web fonts share builtin typefaces, use CORS, deduplicate sources, and honor Unicode aliases", async () => {
  const { CanvasKit, builtinTypefaces, fontCollection } = await loadGraphics();
  const bytes = await Bun.file(new URL("../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
  const requests = [], errors = [];
  let changed = 0;
  const fonts = new DocumentFonts({ CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection,
    fetch: async request => { requests.push(request); return { status: 200, body: bytes }; },
    changed: () => changed++, error: error => errors.push(error) });
  const latin = face("Example", 400, [[0, 127]]);
  const cjk = face("Example", 400, [[0x4e00, 0x9fff]]);
  fonts.update([latin, cjk], [run("Hello中文", ["Example"])]);
  await fonts.ready();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ mode: "cors", credentials: "same-origin", redirect: "follow" });
  expect(changed).toBe(2);
  expect(errors).toEqual([]);
  expect(fonts.collection).not.toBe(fontCollection);
  expect(fonts.resolve("Example", 400, "normal", 65)).toHaveLength(1);
  expect(fonts.resolve("Example", 400, "normal", 0x4e00)).toHaveLength(1);
  expect(fonts.resolve("Example", 400, "normal", 0x400)).toEqual([]);
  fonts.dispose();
  fonts.dispose();
  expect(fonts.collection).toBe(fontCollection);
});

test("font sources try local/fetch alternatives and pending requests abort on document disposal", async () => {
  const { CanvasKit, builtinTypefaces, fontCollection } = await loadGraphics();
  let fetched = 0, aborted = 0;
  const fonts = new DocumentFonts({ CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection,
    fetch: () => {
      fetched++;
      let reject;
      const pending = new Promise((_, fail) => reject = fail);
      pending.abort = () => { aborted++; reject(new Error("disposed")); };
      return pending;
    } });
  const local = face("Local", 400, undefined, { sources: [{ local: "missing" }, { local: builtinTypefaces[0].family }] });
  fonts.update([local], [run("hello", ["Local"])]);
  await fonts.ready();
  expect(fonts.resolve("Local")).toHaveLength(1);
  expect(fetched).toBe(0);
  const remote = face("Remote");
  fonts.update([remote], [run("hello", ["Remote"])]);
  expect(fetched).toBe(1);
  fonts.dispose();
  await fonts.ready();
  expect(aborted).toBe(1);
});

test("font indexes preserve subset order, case-insensitive families, and changed face lists", async () => {
  const { CanvasKit, builtinTypefaces, fontCollection } = await loadGraphics();
  const local = { sources: [{ local: builtinTypefaces[0].family }] };
  const fonts = new DocumentFonts({ CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection,
    fetch: () => { throw new Error("local faces must not fetch"); } });
  try {
    const latin = face("Indexed", 400, [[0, 127]], local);
    const capitals = face("iNDEXED", 400, [[65, 90]], local);
    const cjk = face("Indexed", 400, [[0x4e00, 0x9fff]], local);
    fonts.update([latin, capitals, cjk], [run("Aa中", ["INDEXED"])]);
    await fonts.ready();
    const latinAlias = fonts.resolve("indexed", 400, "normal", 97)[0];
    const capitalsAlias = fonts.resolve("INDEXED", 400, "normal", 65)[0];
    const cjkAlias = fonts.resolve("Indexed", 400, "normal", 0x4e2d)[0];
    expect(new Set([latinAlias, capitalsAlias, cjkAlias]).size).toBe(3);
    expect(fonts.resolve("iNdExEd", 400, "normal", 65)).toEqual([capitalsAlias, latinAlias]);
    expect(fonts.resolve("indexed")).toEqual([cjkAlias, capitalsAlias, latinAlias]);

    fonts.setFaces([cjk, capitals, latin]);
    expect(fonts.resolve("Indexed", 400, "normal", 65)).toEqual([latinAlias, capitalsAlias]);
    fonts.setFaces([cjk]);
    expect(fonts.resolve("Indexed", 400, "normal", 65)).toEqual([]);
    expect(fonts.resolve("Indexed", 400, "normal", 0x4e2d)).toEqual([cjkAlias]);
    fonts.setFaces([]);
    expect(fonts.hasUnicodeRanges).toBe(false);
    expect(fonts.resolve("Indexed")).toEqual([]);
    // Equivalent new descriptor objects still refer to the existing record.
    fonts.setFaces([structuredClone(latin)]);
    expect(fonts.resolve("Indexed", 400, "normal", 65)).toEqual([latinAlias]);
    const returned = fonts.resolve("Indexed"); returned.length = 0;
    expect(fonts.resolve("Indexed")).toEqual([latinAlias]);

    // setFaces must also notice edits to an existing descriptor/array.
    const mutable = [latin];
    fonts.setFaces(mutable);
    latin.family = "Renamed";
    latin.unicodeRanges = [[0x400, 0x4ff]];
    fonts.update(mutable, [run("Ж", ["renamed"])]);
    await fonts.ready();
    expect(fonts.resolve("Indexed")).toEqual([]);
    expect(fonts.resolve("Renamed", 400, "normal", 65)).toEqual([]);
    expect(fonts.resolve("Renamed", 400, "normal", 0x416)).toHaveLength(1);
  } finally { fonts.dispose(); }
});

test("ranked faces observe aliases loaded later and changed font weights/styles", async () => {
  const { CanvasKit, builtinTypefaces, fontCollection } = await loadGraphics();
  const bytes = await Bun.file(new URL("../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const fonts = new DocumentFonts({ CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection,
    fetch: () => response });
  try {
    const regular = face("Delayed", 400, [[0, 127]]);
    const medium = face("Delayed", 500, [[0, 127]]);
    const italic = face("Delayed", 400, [[0, 127]], { style: "italic" });
    fonts.update([regular, medium, italic], [run("a", ["Delayed"]), run("a", ["Delayed"], 500), run("a", ["Delayed"], 400, "italic")]);
    expect(fonts.resolve("Delayed", 400, "normal", 65)).toEqual([]);
    expect(fonts.resolve("Delayed", 450, "normal", 65)).toEqual([]);
    expect(fonts.resolve("Delayed", 400, "italic", 65)).toEqual([]);
    finish({ status: 200, body: bytes });
    await fonts.ready();
    const regularAlias = fonts.resolve("Delayed", 400, "normal", 65)[0];
    const mediumAlias = fonts.resolve("Delayed", 500, "normal", 65)[0];
    const italicAlias = fonts.resolve("Delayed", 400, "italic", 65)[0];
    expect(new Set([regularAlias, mediumAlias, italicAlias]).size).toBe(3);
    expect(fonts.resolve("Delayed", 450, "normal", 65)).toEqual([mediumAlias, regularAlias, italicAlias]);
    expect(fonts.resolve("Delayed", 400, "italic", 65)).toEqual([italicAlias, regularAlias, mediumAlias]);
    fonts.setFaces([medium]);
    expect(fonts.resolve("Delayed", 400, "normal", 65)).toEqual([mediumAlias]);
    // More style combinations than the bounded rank cache can hold must not
    // change either a new lookup or one evicted earlier.
    for (let weight = 1; weight <= 160; weight++) expect(fonts.resolve("Delayed", weight, "normal", 65)).toEqual([mediumAlias]);
    expect(fonts.resolve("Delayed", 450, "normal", 65)).toEqual([mediumAlias]);
  } finally { fonts.dispose(); }
});

test("loaded web font updates geometry, respects Unicode ranges, and resets on navigation", async () => {
  const bytes = await Bun.file(new URL("../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
  let finish;
  const fontResponse = new Promise(resolve => finish = resolve);
  let requests = 0;
  const renderer = await createPageRenderer({ fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
    pageFetch: () => { requests++; return fontResponse; } });
  try {
    const source = `<style>@font-face {font-family:TestMono;src:url(/font.ttf);unicode-range:U+0069} span{font-family:TestMono,sans-serif;font-size:30px}</style><span id=i>iiii</span><span id=m>mmmm</span>`;
    await renderer.loadDocument({ url: "https://font.test/", status: 200, contentType: "text/html", source });
    const before = renderer.inspect("span").map(item => item.box.width);
    finish({ status: 200, body: bytes });
    await renderer.whenLoaded();
    const after = renderer.inspect("span").map(item => item.box.width);
    expect(requests).toBe(1);
    expect(after[0]).toBeGreaterThan(before[0] * 2);
    expect(after[1]).toBe(before[1]);
    await renderer.loadDocument({ url: "https://font.test/next", status: 200, contentType: "text/html",
      source: `<span style="font-family:TestMono,sans-serif;font-size:30px">iiii</span>` });
    await renderer.whenLoaded();
    expect(renderer.inspect("span")[0].box.width).toBe(before[0]);
  } finally { renderer.dispose(); }
});

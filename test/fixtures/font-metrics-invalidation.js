// Isolate prototype counters and the forced full-cascade reference.
import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { StyleEngine } from "../../lib/style/computed-style.js";

const font = await Bun.file(new URL("../../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
const compute = StyleEngine.prototype.compute;
const dependency = Object.getOwnPropertyDescriptor(StyleEngine.prototype, "usesFontMetrics");
let computations, currentDocument;
StyleEngine.prototype.compute = function (...args) {
  currentDocument = args[0];
  const result = compute.apply(this, args);
  computations?.push({ count: this.restyled, full: !this.incremental });
  return result;
};

async function snapshot(extra, forceFull, mutate = false) {
  if (forceFull) Object.defineProperty(StyleEngine.prototype, "usesFontMetrics", { configurable: true, get: () => true });
  else Object.defineProperty(StyleEngine.prototype, "usesFontMetrics", dependency);
  let finish, requests = 0;
  const response = new Promise(resolve => { finish = resolve; });
  const renderer = await createPageRenderer({
    fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
    pageFetch: () => { requests++; return response; },
  });
  try {
    renderer.resize(400, 300, 1);
    await renderer.loadDocument({ url: "https://font.test/", contentType: "text/html", source: `<!doctype html>
      <style>@font-face{font-family:Delayed;src:url(/font.ttf)}
      @font-face{font-family:Unused;src:url(/never.ttf)}
      body{margin:0;font:16px Delayed,sans-serif;line-height:normal}
      #probe,.atom{display:inline-block;padding:2px}
      .flex{display:flex;width:180px}.grid{display:grid;grid-template-columns:min-content 1fr;width:180px}
      ${extra}</style>
      <div id=probe>iiii</div><div id=changed>normal line height</div>
      <div class=flex><span class=atom>iiii Hello</span><span class=atom>more words</span></div>
      <div class=grid><span>iii iii</span><span>word word word</span></div>
      <div style="width:150px">${'wrapping text '.repeat(12)}</div>` });
    const before = renderer.inspect("#probe")[0].box.width;
    if (mutate) {
      // Pending DOM/style invalidation must not be replaced by font-only work.
      const changed = currentDocument.getElementById("changed");
      changed.style.width = "123px";
      changed.style.color = "blue";
      changed.insertAdjacentHTML("beforeend", '<span style="display:block;height:19px">inserted</span>');
    }
    computations = [];
    finish({ status: 200, body: font });
    await renderer.whenLoaded();
    const after = renderer.inspect("#probe")[0].box.width;
    const changed = renderer.inspect("#changed", ["width", "color"])[0];
    const captured = await renderer.screenshot({ format: "rgba" });
    assert.equal(requests, 1, "unused font definitions must not load or reset layout");
    return { before, after, changed, pixels: Buffer.from(captured.pixels), computations: [...computations] };
  } finally { computations = null; renderer.dispose(); }
}

try {
  for (const [name, extra, usesMetrics] of [
    ["ordinary text", "", false],
    ["ch", "#probe{width:10ch}", true],
    ["custom variable", "body{--size:4ch}#probe{width:calc(var(--size) + 5px)}", true],
    ["pseudo", "#probe::before{content:'x';display:inline-block;width:2ch}", true],
    ["root font size", "html{font-family:Delayed,sans-serif;font-size:2ch}#probe{width:10rem}", true],
  ]) {
    const candidate = await snapshot(extra, false);
    const reference = await snapshot(extra, true);
    assert.deepEqual(candidate.pixels, reference.pixels, name + " pixels must match a fresh full cascade");
    assert.equal(candidate.after, reference.after, name + " geometry must match");
    // Root font-size ch uses the initial/parent font while resolving size,
    // so it is a conservative dependency even if this face cannot affect it.
    if (name !== "root font size") assert.ok(candidate.after > candidate.before, name + " must use the newly loaded face");
    assert.equal(candidate.computations.some(entry => entry.full), usesMetrics, name + " cascade dependency");
    if (!usesMetrics) assert.equal(candidate.computations.reduce((sum, entry) => sum + entry.count, 0), 0,
      "ordinary text changes font metrics without recomputing CSS");
  }
  const candidate = await snapshot("", false, true);
  const reference = await snapshot("", true, true);
  assert.deepEqual(candidate.pixels, reference.pixels, "simultaneous DOM changes must match full cascade");
  assert.equal(candidate.changed.box.width, 123);
  assert.equal(candidate.changed.style.color, "rgba(0, 0, 255, 1)");
  assert.ok(candidate.computations.some(entry => entry.count > 0), "pending DOM changes still restyle");
  process.stdout.write("font metrics invalidation integration passed\n");
} finally {
  StyleEngine.prototype.compute = compute;
  Object.defineProperty(StyleEngine.prototype, "usesFontMetrics", dependency);
}

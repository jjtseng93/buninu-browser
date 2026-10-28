import assert from "node:assert/strict";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { LayoutEngine } from "../../lib/layout/text-layout.js";

let layouts = 0;
const originalLayout = LayoutEngine.prototype.layout;
LayoutEngine.prototype.layout = function (...args) {
  layouts++;
  return Reflect.apply(originalLayout, this, args);
};
const errors = [];
const renderer = await createPageRenderer({ reportError: error => errors.push(String(error)) });
await import("../../vendor/ses/dist/ses.mjs");
lockdown({ errorTaming: "safe", overrideTaming: "severe", consoleTaming: "unsafe",
  localeTaming: "unsafe", stackFiltering: "concise", reporting: "none" });

const source = controls => `<!doctype html>
  <style id=sheet>body{margin:0;background:white}video{display:block;width:160px;height:90px}</style>
  <video id=v ${controls ? "controls" : ""}></video>`;
const load = async controls => {
  await renderer.loadDocument({ url: "https://controls.test/", contentType: "text/html", source: source(controls) });
  await renderer.whenLoaded();
};
const snapshot = async () => ({
  pixels: new Bun.CryptoHasher("sha256").update(Buffer.from(await renderer.screenshot(), "base64")).digest("hex"),
  geometry: await renderer.evaluate(`JSON.stringify((() => {
    const rect = document.getElementById("v").getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  })())`),
});

try {
  renderer.setScripting("ses");
  renderer.resize(240, 140, 1);
  const references = [];
  for (const controls of [false, true]) {
    await load(controls);
    references.push(await snapshot());
  }
  assert.notEqual(references[0].pixels, references[1].pixels, "native controls visibly change the video");
  assert.equal(references[0].geometry, references[1].geometry, "native controls retain the video's box");

  await load(false);
  const transitions = [
    ["add attribute", true, `document.getElementById("v").setAttribute("controls", "")`],
    ["remove after style-only read", false, `
      document.getElementById("v").removeAttribute("controls");
      getComputedStyle(document.getElementById("v")).color;
      document.getElementById("v").getBoundingClientRect()`],
    ["add during full stylesheet pass", true, `
      document.getElementById("sheet").textContent += " p { color:red }";
      document.getElementById("v").setAttribute("controls", "")`, true],
    ["remove after mutation delivery", false, `
      document.getElementById("v").removeAttribute("controls");
      new Promise(resolve => setTimeout(resolve, 0))`],
    ["enable reflected property", true, `document.getElementById("v").controls = true`],
    ["disable reflected property", false, `document.getElementById("v").controls = false`],
  ];
  for (const [name, controls, expression, changesSheet] of transitions) {
    const before = layouts;
    await renderer.evaluate(expression);
    const actual = await snapshot();
    assert.equal(actual.pixels, references[Number(controls)].pixels, name + " pixels match a fresh document");
    assert.equal(actual.geometry, references[Number(controls)].geometry, name + " retains geometry");
    if (!changesSheet) assert.equal(layouts - before, 0, name + " reuses layout");
  }
  assert.deepEqual(errors, []);
  console.log("video controls paint invalidation passed");
} finally {
  renderer.dispose();
}

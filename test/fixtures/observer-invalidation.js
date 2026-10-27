// Host scripting and the style-read counter stay outside the test runner.
import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { nodeOf } from "../../lib/renderer/bindings.js";
import { StyleEngine } from "../../lib/style/computed-style.js";

const font = await Bun.file(new URL("../../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
const sleep = Bun.sleep;
let finishFont;
const fontResponse = new Promise(resolve => { finishFont = resolve; });
const renderer = await createPageRenderer({
  fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
  pageFetch: () => fontResponse,
});
const evaluate = code => renderer.evaluate(code);
const eventually = async (code, check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await evaluate(code);
    if (check(value)) return value;
    await sleep(10);
  }
  assert.fail(message);
};
const originalGet = StyleEngine.prototype.get;
try {
  renderer.resize(400, 300, 1);
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://observer.test/", contentType: "text/html", source: `<!doctype html>
    <style id=sheet>body{margin:0}#box{width:100px;height:50px}
      body[data-wide] #box{width:175px}
      #viewport{width:50%;height:10px}
      #scroller{position:absolute;top:80px;width:100px;height:100px;overflow:auto}
      #inside{position:absolute;top:150px;width:20px;height:20px}
      #below{position:absolute;top:500px;width:20px;height:20px}</style>
    <div id=box></div><div id=viewport></div>
    <div id=scroller><div style="position:relative;height:300px"><div id=inside></div></div></div>
    <div id=below></div><div style="height:1000px"></div>` });
  await renderer.whenLoaded();
  await evaluate(`window.box=document.getElementById('box');window.sizes=[];window.intersections=[];
    window.ro=new ResizeObserver(entries=>sizes.push(entries[0].contentRect.width));ro.observe(box);
    window.io=new IntersectionObserver(entries=>intersections.push(entries[0].isIntersecting));io.observe(box);`);
  await eventually("sizes.length===1&&intersections.length===1", Boolean, "initial observers should be delivered");
  // Consume initial focus bookkeeping, then count actual style measurements
  // of the observed box. Reading body geometry itself cannot touch this box.
  await evaluate("document.body.setAttribute('data-warm','1');document.body.clientWidth");
  await sleep(40);
  const target = nodeOf(globalThis.document.getElementById("box"));
  let measurements = 0;
  StyleEngine.prototype.get = function (element) {
    if (element === target) measurements++;
    return originalGet.call(this, element);
  };
  for (let i = 0; i < 5; i++) {
    await evaluate(`document.body.setAttribute('data-counter','${i}');document.body.clientWidth`);
    await sleep(30);
  }
  assert.equal(measurements, 0, "metadata flushes must not remeasure unchanged observer targets");
  assert.deepEqual(await evaluate("[sizes,intersections]"), [[100], [true]]);
  StyleEngine.prototype.get = originalGet;

  // observe() itself still queues a first measurement without a new version.
  await evaluate("window.newSizes=[];window.newRO=new ResizeObserver(e=>newSizes.push(e[0].contentRect.width));newRO.observe(box)");
  await eventually("newSizes[0]", value => value === 100, "new observers must not wait for invalidation");
  await evaluate("box.style.width='150px';document.body.clientWidth");
  await eventually("sizes.at(-1)", value => value === 150, "inline size changes must notify");
  await evaluate("box.style.width='';document.body.setAttribute('data-wide','');document.body.clientWidth");
  await eventually("sizes.at(-1)", value => value === 175, "selector-observed metadata must still invalidate");
  await evaluate("document.getElementById('sheet').textContent+='body[data-wide] #box{width:190px}';document.body.clientWidth");
  await eventually("sizes.at(-1)", value => value === 190, "stylesheet changes must notify");

  await evaluate(`window.insideChanges=[];window.belowChanges=[];window.viewportSizes=[];window.deviceSizes=[];
    window.insideIO=new IntersectionObserver(e=>insideChanges.push(e[0].isIntersecting));insideIO.observe(document.getElementById('inside'));
    window.belowIO=new IntersectionObserver(e=>belowChanges.push(e[0].isIntersecting));belowIO.observe(document.getElementById('below'));
    window.viewportRO=new ResizeObserver(e=>viewportSizes.push(e[0].contentRect.width));viewportRO.observe(document.getElementById('viewport'));
    window.deviceRO=new ResizeObserver(e=>deviceSizes.push(e[0].devicePixelContentBoxSize[0].inlineSize));deviceRO.observe(box,{box:'device-pixel-content-box'});`);
  await eventually("insideChanges.length===1&&belowChanges.length===1&&viewportSizes.length===1&&deviceSizes.length===1", Boolean,
    "scroll/viewport observers should be initialized");
  assert.deepEqual(await evaluate("[insideChanges,belowChanges,viewportSizes,deviceSizes]"), [[false], [false], [200], [190]]);
  await evaluate("document.getElementById('scroller').scrollTop=100");
  await eventually("insideChanges.at(-1)", Boolean, "element scrolling must notify");
  renderer.scrollTo(0, 450);
  await eventually("belowChanges.at(-1)", Boolean, "viewport scrolling must notify");
  renderer.scrollTo(0, 0);
  renderer.resize(400, 300, 2);
  await eventually("deviceSizes.at(-1)", value => value === 380, "DPR-only changes must notify without layout invalidation");
  renderer.resize(600, 300, 2);
  await eventually("viewportSizes.at(-1)", value => value === 300, "viewport resizing must notify");
  await evaluate("box.remove();document.body.clientWidth");
  await eventually("sizes.at(-1)===0&&intersections.at(-1)===false", Boolean, "removing a target must notify");
  await evaluate("document.body.prepend(box);document.body.clientWidth");
  await eventually("sizes.at(-1)===190&&intersections.at(-1)===true", Boolean, "reattaching a target must notify");

  // Font completion is a resource invalidation even with no DOM mutation.
  await evaluate(`document.body.insertAdjacentHTML('beforeend',
    '<span id=text style="display:inline-block;font-family:ObserverMono,sans-serif;font-size:30px">iiii</span>')`);
  await evaluate("window.fontSizes=[];window.fontRO=new ResizeObserver(e=>fontSizes.push(e[0].contentRect.width));fontRO.observe(document.getElementById('text'))");
  const before = await eventually("fontSizes[0]", value => value > 0, "fallback font should be measured");
  await evaluate(`document.getElementById('sheet').textContent+='@font-face{font-family:ObserverMono;src:url(/font.ttf)}';document.body.clientWidth`);
  finishFont({ status: 200, body: font });
  await eventually("fontSizes.at(-1)", value => value > before * 2, "loaded font metrics must notify");
  process.stdout.write("observer invalidation integration passed\n");
} finally {
  StyleEngine.prototype.get = originalGet;
  renderer.dispose();
}

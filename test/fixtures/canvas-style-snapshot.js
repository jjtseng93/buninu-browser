import assert from "node:assert/strict";
const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const { createPageRenderer } = await import(
  root + "/lib/renderer/page-renderer.js"
);
const { LayoutEngine } = await import(root + "/lib/layout/text-layout.js");
const { StyleEngine } = await import(root + "/lib/style/computed-style.js");
let layouts = 0,
  computes = 0;
const layout = LayoutEngine.prototype.layout,
  compute = StyleEngine.prototype.compute;
LayoutEngine.prototype.layout = function (...args) {
  layouts++;
  return layout.apply(this, args);
};
StyleEngine.prototype.compute = function (...args) {
  computes++;
  return compute.apply(this, args);
};
const renderer = await createPageRenderer({});
await import(root + "/vendor/ses/dist/ses.mjs");
lockdown({
  errorTaming: "safe",
  overrideTaming: "severe",
  consoleTaming: "unsafe",
  localeTaming: "unsafe",
  stackFiltering: "concise",
  reporting: "none",
});
try {
  renderer.setScripting("ses");
  await renderer.loadDocument({
    url: "https://canvas.test/",
    contentType: "text/html",
    source:
      '<div id="hidden" style="display:none;font-size:20px"><canvas id="c" width="100" height="50" style="font-size:24px"></canvas></div><canvas id="v" width="100" height="50"></canvas>',
  });
  await renderer.whenLoaded();
  await renderer.evaluate(
    `window.c=document.getElementById('c');window.ctx=c.getContext('2d');window.v=document.getElementById('v');window.vctx=v.getContext('2d')`,
  );
  const measure = await renderer.evaluate(
    `c.style.fontSize='40px';ctx.font='1em sans-serif';ctx.measureText('MMMM').width`,
  );
  const eagerCurrent = await renderer.evaluate(
    `ctx.font='40px sans-serif';ctx.measureText('MMMM').width`,
  );
  assert.equal(measure, eagerCurrent);
  const before = { layouts, computes };
  // Count renderer style/layout work around a batch of canvas operations.
  const result = await renderer.evaluate(
    `(() => {c.style.fontSize='20px';ctx.font='2em sans-serif';const width=ctx.measureText('MMMM').width;v.style.direction='rtl';vctx.direction='inherit';vctx.font='12px sans-serif';vctx.fillText('abc',50,20);for(let i=0;i<30;i++){ctx.measureText('MMMM');vctx.fillText('abc',50,20)}return width;})()`,
  );
  assert.equal(result, eagerCurrent);
  const after = { layouts, computes };
  // evaluate's trailing refresh may produce one layout, never one per draw.
  assert.ok(after.layouts - before.layouts <= 1);
  assert.ok(after.computes - before.computes <= 3);
  const clean = { layouts, computes };
  await renderer.evaluate(
    `for(let i=0;i<30;i++){ctx.measureText('MMMM');vctx.fillText('abc',50,20)}`,
  );
  assert.equal(layouts, clean.layouts);
  assert.equal(computes, clean.computes);
  console.log(
    JSON.stringify({
      pass: true,
      firstPendingMutationMatchesExplicit40px: true,
      before,
      after,
      cleanDraws: {
        layouts: layouts - clean.layouts,
        computes: computes - clean.computes,
      },
    }),
  );
} finally {
  renderer.dispose();
  LayoutEngine.prototype.layout = layout;
  StyleEngine.prototype.compute = compute;
}

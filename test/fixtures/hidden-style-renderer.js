import assert from "node:assert/strict";
const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, ""),
  mode = "ses";
const { createPageRenderer } = await import(
  root + "/lib/renderer/page-renderer.js"
);
const errors = [],
  requests = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XQAAAAASUVORK5CYII=",
  "base64",
);
const mono = await Bun.file(
  root + "/usr/share/fonts/DejaVuSansMono.ttf",
).bytes();
const sans = await Bun.file(
  root + "/usr/share/fonts/Roboto-Regular.ttf",
).bytes();
const options = {
  reportError: (e) => errors.push(String(e)),
  pageFetch: async ({ url }) => {
    requests.push(url);
    return {
      status: 200,
      body: url.endsWith("mono.ttf")
        ? mono
        : url.endsWith("sans.ttf")
          ? sans
          : png,
    };
  },
  fetchResource: async (url) => {
    requests.push(url);
    return { ok: true, status: 200, url, body: png };
  },
};
const renderer = await createPageRenderer(options);
if (mode === "ses") {
  await import(root + "/vendor/ses/dist/ses.mjs");
  lockdown({
    errorTaming: "safe",
    overrideTaming: "severe",
    consoleTaming: "unsafe",
    localeTaming: "unsafe",
    stackFiltering: "concise",
    reporting: "none",
  });
}
const phases = [];
async function state(label, mutation = "") {
  if (mutation) await renderer.evaluate(mutation);
  const values = await renderer.evaluate(
    `(() => {const ids=['outer','nested','leaf','grand','new','canvas'];return ids.map(id=>{const e=document.getElementById(id);if(!e)return null;const s=getComputedStyle(e);const b=e.getBoundingClientRect();return {id,color:s.color,width:s.width,height:s.height,padding:s.padding,fontSize:s.fontSize,display:s.display,custom:s.getPropertyValue('--tone'),rect:[b.x,b.y,b.width,b.height]};});})()`,
  );
  const saved = await renderer.evaluate(
    `window.saved ? [saved.color,saved.width,saved.getPropertyValue('--tone'),saved.length,keys===Object.keys(saved).join('|')] : null`,
  );
  const image = await renderer.screenshot({ format: "rgba" });
  phases.push({
    label,
    values,
    saved,
    pixelHash: new Bun.CryptoHasher("sha256")
      .update(image.pixels)
      .digest("hex"),
  });
  const source = await renderer.evaluate("document.documentElement.outerHTML");
  const fresh = await createPageRenderer({
    ...options,
    pageFetch: async ({ url }) => ({
      status: 200,
      body: url.endsWith("mono.ttf")
        ? mono
        : url.endsWith("sans.ttf")
          ? sans
          : png,
    }),
    fetchResource: async (url) => ({ ok: true, status: 200, url, body: png }),
  });
  try {
    fresh.setScripting(mode);
    fresh.resize(
      label === "viewport" ||
        [
          "remove-font",
          "replace-font",
          "replacement-ready",
          "final-reveal",
        ].includes(label)
        ? 220
        : 320,
      180,
      1,
    );
    await fresh.loadDocument({
      url: "https://hidden.test/",
      contentType: "text/html",
      source,
    });
    await fresh.whenLoaded();
    const expected = await fresh.screenshot({ format: "rgba" });
    if (!Buffer.from(image.pixels).equals(Buffer.from(expected.pixels)))
      throw new Error(
        label +
          " pixel mismatch " +
          Bun.hash(image.pixels) +
          "/" +
          Bun.hash(expected.pixels),
      );
    const expectedGeometry = fresh.inspect(
      "#outer,#nested,#leaf,#grand,#new,#canvas",
      ["color", "width", "height", "fontSize", "display"],
    );
    const actualGeometry = renderer.inspect(
      "#outer,#nested,#leaf,#grand,#new,#canvas",
      ["color", "width", "height", "fontSize", "display"],
    );
    if (!Bun.deepEquals(actualGeometry, expectedGeometry, true))
      throw new Error(
        label +
          " geometry mismatch " +
          JSON.stringify({ actualGeometry, expectedGeometry }),
      );
  } finally {
    fresh.dispose();
  }
}
try {
  renderer.setScripting(mode);
  renderer.resize(320, 180, 1);
  await renderer.loadDocument({
    url: "https://hidden.test/",
    contentType: "text/html",
    source: `<!doctype html><style id="faces">@font-face{font-family:Probe;src:url(/mono.ttf)}</style><style id="rules">html{font-size:18px}body{margin:0}#visible{width:210px;background:yellow;color:purple;--tone:green}#outer{display:none;color:red;--tone:blue}#nested{display:none;font-size:20px}.child{display:inline-block;background:var(--tone);width:3ch;height:2em;padding:1rem;font-family:Probe,serif}.child::before{content:'x';color:orange}#outer:has(.active) .child{color:teal}@media(max-width:250px){.child{padding:3px}}</style><span style="font-family:Probe">0</span><div id="outer"><section id="nested"><i class="child" id="grand">grand</i></section><section id="chain"><span id="leaf" class="child">leaf</span><canvas id="canvas" width="30" height="20"></canvas><img src="/pixel.png" width="10" height="10"></section></div><div id="visible">visible</div>`,
  });
  await renderer.whenLoaded();
  await renderer.evaluate(
    `window.leaf=document.getElementById('leaf');window.saved=getComputedStyle(leaf);window.keys=Object.keys(saved).join('|')`,
  );
  await state("initial-hidden");
  await state(
    "hidden-values-mutate",
    `document.getElementById('outer').style.cssText='display:none;color:green;--tone:pink';leaf.style.width='5ch';document.getElementById('nested').style.fontSize='31px'`,
  );
  await state("clean-repeat");
  await state(
    "insert",
    `document.getElementById('chain').insertAdjacentHTML('beforeend','<em class="child" id="new" style="width:inherit">new</em>')`,
  );
  await state("selector-change", `leaf.classList.add('active')`);
  await state(
    "new-sheet",
    `document.getElementById('rules').textContent+=' .child{border:2px solid currentColor}'`,
  );
  await state(
    "nested-reveal-hidden",
    `document.getElementById('nested').style.display='block'`,
  );
  await state(
    "outer-reveal",
    `document.getElementById('outer').style.display='block'`,
  );
  await state(
    "hidden-again",
    `document.getElementById('outer').style.display='none'`,
  );
  await state(
    "move-leaf-visible",
    `document.getElementById('visible').append(leaf)`,
  );
  await state("detached", `leaf.remove()`);
  await state(
    "detached-mutate",
    `leaf.style.color='rgb(12,34,56)';leaf.style.width='77px'`,
  );
  await state(
    "reattach-hidden",
    `document.getElementById('chain').append(leaf)`,
  );
  await state("root-rem", `document.documentElement.style.fontSize='22px'`);
  renderer.resize(220, 180, 1);
  await state("viewport");
  await state("remove-font", `document.getElementById('faces').textContent=''`);
  await state(
    "replace-font",
    `document.getElementById('faces').textContent='@font-face{font-family:Probe;src:url(/sans.ttf)}'`,
  );
  await Bun.sleep(0);
  await state("replacement-ready");
  await state(
    "final-reveal",
    `document.getElementById('outer').style.display='block'`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.map((x) => new URL(x).pathname).sort(), [
    "/mono.ttf",
    "/pixel.png",
    "/sans.ttf",
  ]);
  console.log(JSON.stringify({ pass: true, states: phases.length }));
} finally {
  renderer.dispose();
}

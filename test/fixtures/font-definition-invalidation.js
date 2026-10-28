// Compare edited font definitions against fresh documents and count CSS work.
import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { StyleEngine } from "../../lib/style/computed-style.js";

const mono = await Bun.file(new URL("../../usr/share/fonts/DejaVuSansMono.ttf", import.meta.url)).bytes();
const sans = await Bun.file(new URL("../../usr/share/fonts/Roboto-Regular.ttf", import.meta.url)).bytes();
const primary = '@font-face{font-family:DefinitionPrimary;src:url(/mono.ttf)}';
const alias = '@font-face{font-family:DefinitionAlias;src:url(/sans.ttf)}';
const phases = [
  ["loaded", primary + alias],
  ["remove primary", alias],
  ["rename primary", primary.replace("DefinitionPrimary", "UnusedDefinition") + alias],
  ["replace source", primary.replace("/mono.ttf", "/sans.ttf") + alias],
  ["restore primary", primary + alias],
  ["remove all", ""],
  ["restore all", primary + alias],
];
const compute = StyleEngine.prototype.compute;
let computations = null;
let currentDocument = null;
StyleEngine.prototype.compute = function (...args) {
  currentDocument = args[0];
  const result = compute.apply(this, args);
  computations?.push({ count: this.restyled, full: !this.incremental });
  return result;
};

async function open(definitions, usesMetrics) {
  let requests = 0;
  const renderer = await createPageRenderer({
    fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
    pageFetch: async ({ url }) => {
      requests++;
      return { status: 200, body: url.endsWith("/mono.ttf") ? mono : sans };
    },
  });
  renderer.resize(400, 250, 1);
  await renderer.loadDocument({ url: "https://font-definition.test/", contentType: "text/html", source: `<!doctype html>
    <style id=faces>${definitions}</style><style>
      body{margin:0}#auto,#metric{display:inline-block;font:30px DefinitionPrimary,DefinitionAlias,sans-serif}
      #metric{${usesMetrics ? "width:10ch" : "padding:2px"}}
      #preload{font:20px DefinitionAlias,sans-serif}
    </style><span id=auto>iiii</span><br><span id=metric>metric</span><div id=preload>preload alias</div>` });
  await renderer.whenLoaded();
  return { renderer, document: currentDocument, requests: () => requests };
}

async function capture(renderer) {
  const geometry = renderer.inspect("#auto,#metric", ["width"]);
  const image = await renderer.screenshot({ format: "rgba" });
  return { geometry, pixels: Buffer.from(image.pixels) };
}

try {
  for (const usesMetrics of [false, true]) {
    const live = await open(phases[0][1], usesMetrics);
    const snapshots = [];
    try {
      for (const [index, [name, definitions]] of phases.entries()) {
        computations = [];
        if (index) {
          live.document.getElementById("faces").textContent = definitions;
          // Repeated viewport metrics flush mutations without changing any
          // layout input; font definition invalidation must reset the caches.
          live.renderer.resize(400, 250, 1);
          // Font bytes are already available; drain the cached-source promise
          // chain that registers a new alias when a descriptor is replaced.
          await Bun.sleep(0);
        }
        snapshots.push(await capture(live.renderer));
        if (index) assert.equal(computations.some(entry => entry.full), usesMetrics,
          `${name}: only font-relative computed lengths require a full cascade`);
        assert.equal(live.requests(), 2, `${name}: cached sources and unused definitions must not refetch fonts`);
        computations = null;
      }
    } finally { computations = null; live.renderer.dispose(); }

    for (const [index, [name, definitions]] of phases.entries()) {
      const fresh = await open(definitions, usesMetrics);
      try {
        const expected = await capture(fresh.renderer);
        assert.deepEqual(snapshots[index].geometry, expected.geometry, `${name}: fresh layout geometry`);
        assert.deepEqual(snapshots[index].pixels, expected.pixels, `${name}: fresh layout pixels`);
      } finally { fresh.renderer.dispose(); }
    }
    assert.ok(snapshots[1].geometry[0].box.width < snapshots[0].geometry[0].box.width / 2,
      "removing the primary face must select the narrower loaded fallback");
    assert.deepEqual(snapshots.at(-1), snapshots[0], "restoring definitions must restore geometry and pixels");
    if (usesMetrics) assert.notEqual(snapshots[1].geometry[1].style.width, snapshots[0].geometry[1].style.width,
      "ch lengths must use the replacement font metrics");
  }
  process.stdout.write("font definition invalidation integration passed\n");
} finally {
  computations = null;
  StyleEngine.prototype.compute = compute;
}

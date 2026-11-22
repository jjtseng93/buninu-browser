// Host scripting is isolated from the test runner's globals.
import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { nodeOf } from "../../lib/renderer/bindings.js";
const renderer = await createPageRenderer({
  fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
});
try {
  renderer.resize(400, 300, 1);
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://resource.test/", contentType: "text/html",
    source: '<!doctype html><style>body{color:red}</style><body>' + '<div>Item</div>'.repeat(100) + '</body>' });
  await renderer.whenLoaded();
  await renderer.evaluate("document.body.setAttribute('data-warm','1');document.body.clientWidth");
  const document = nodeOf(globalThis.document), query = document.querySelectorAll.bind(document);
  const watched = new Set(["video, audio", "img", "style, link[rel~='stylesheet']", "iframe"]);
  const queries = [];
  document.querySelectorAll = selector => {
    if (watched.has(selector)) queries.push(selector);
    return query(selector);
  };
  await renderer.evaluate(`for(let i=0;i<30;i++) {
    document.body.setAttribute('data-counter',String(i));
    document.body.setAttribute('aria-label',String(i));
    document.body.clientWidth;
  }`);
  assert.deepEqual(queries, [], "metadata-only geometry flushes retain resource discovery");
  const wrapper = globalThis.document.createElement('video');
  const video = nodeOf(wrapper), reads = [];
  const getAttribute = video.getAttribute.bind(video);
  video.getAttribute = name => { reads.push(name); return getAttribute(name); };
  globalThis.document.body.appendChild(wrapper);
  assert.equal(await renderer.evaluate("document.querySelector('video').offsetWidth"), 300);
  assert.ok(reads.includes("width") && reads.includes("height"), "geometry flush initializes inserted media");
  process.stdout.write("resource discovery integration passed\n");
} finally { renderer.dispose(); }

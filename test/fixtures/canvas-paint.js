import { strict as assert } from "node:assert";
import { createPageRenderer, loadGraphics } from "../../lib/renderer/page-renderer.js";
const sleep = Bun.sleep, now = Date.now;
const { CanvasKit: kit } = await loadGraphics();
const redPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==", "base64");
let frames = 0;
const corsRequests = [];
const renderer = await createPageRenderer({ onFrame: () => frames++,
  fetchResource: async url => ({ ok: true, status: 200, url, body: redPng }),
  pageFetch: async request => {
    corsRequests.push(request);
    if (request.url.includes("denied")) throw new TypeError("CORS disallowed");
    return { status: 200, url: request.url, body: new Blob([redPng]).stream() };
  },
});
async function pixel(x = 1, y = 1) {
  const image = kit.MakeImageFromEncoded(Buffer.from(await renderer.screenshot(), "base64"));
  try { return [...image.readPixels(x, y, { width: 1, height: 1, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB })]; }
  finally { image.delete(); }
}
try {
  renderer.resize(400, 300, 1);
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://canvas.test/", contentType: "text/html",
    source: `<body style="margin:0"><canvas id=c style="display:block">fallback must not appear</canvas><span id=after>after</span><script>
      window.canvas = document.getElementById('c'); window.ctx = canvas.getContext('2d');
      ctx.fillStyle='red';ctx.fillRect(0,0,300,150);
    </script>` });
  await renderer.whenLoaded();
  assert.deepEqual(renderer.inspect("canvas")[0].box, { x: 0, y: 0, width: 300, height: 150 });
  assert.ok(renderer.inspect("#after")[0].box.y >= 150);
  assert.deepEqual(await pixel(), [255, 0, 0, 255]);
  assert.equal(await renderer.evaluate("ctx.canvas === canvas"), true);
  assert.equal(await renderer.evaluate("ctx.Hd === undefined"), true, "native internals are not page APIs");
  assert.equal((await renderer.evaluate("document.body.innerText")).includes("fallback"), false);
  const initial = frames;
  await renderer.evaluate("ctx.fillStyle='blue';ctx.fillRect(0,0,300,150)");
  assert.deepEqual(await pixel(), [0, 0, 255, 255], "drawing alone invalidates paint");
  assert.ok(frames > initial);
  await renderer.evaluate("ctx.clearRect(0,0,300,150)");
  assert.deepEqual(await pixel(), [255, 255, 255, 255], "transparent canvas shows page background");
  await renderer.evaluate("ctx.fillStyle='green';ctx.fillRect(0,0,300,150);canvas.width=100");
  assert.equal(renderer.inspect("canvas")[0].box.width, 100);
  assert.deepEqual(await pixel(), [255, 255, 255, 255], "width reset clears displayed bitmap");
  await renderer.evaluate("canvas.style.width='200px';canvas.style.height='100px';ctx.fillStyle='red';ctx.fillRect(0,0,50,150)");
  assert.deepEqual(await pixel(99, 50), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(101, 50), [255, 255, 255, 255]);
  await renderer.evaluate("canvas.remove()");
  await renderer.evaluate("ctx.fillStyle='blue';ctx.fillRect(0,0,100,150);document.body.prepend(canvas)");
  assert.deepEqual(await pixel(1, 1), [0, 0, 255, 255], "detached canvases keep their bitmap when reattached");
  const exported = await renderer.evaluate("canvas.toDataURL('image/png')");
  assert.deepEqual(await new Bun.Image(Buffer.from(exported.split(",")[1], "base64")).metadata(), { width: 100, height: 150, format: "png" });
  assert.ok((await renderer.evaluate("canvas.toDataURL('unsupported/type')")).startsWith("data:image/png;base64,"));
  assert.deepEqual(await renderer.evaluate("new Promise(resolve => canvas.toBlob(blob => resolve([blob.type.startsWith('image/'), blob.size > 0]), 'image/jpeg'))"), [true, true]);
  await renderer.evaluate("window.copy=document.createElement('canvas');copy.width=copy.height=10;window.copyCtx=copy.getContext('2d');copyCtx.drawImage(canvas,0,0,10,10)");
  assert.deepEqual(await renderer.evaluate("[...copyCtx.getImageData(1,1,1,1).data]"), [0, 0, 255, 255]);
  await renderer.evaluate("window.img=document.createElement('img');img.style.display='none';img.src='https://foreign.test/red.png';document.body.appendChild(img)");
  const deadline = now() + 5000;
  while (!await renderer.evaluate("img.complete && img.naturalWidth === 2")) { assert.ok(now() < deadline); await sleep(10); }
  await renderer.evaluate("ctx.drawImage(img,0,0,100,150)");
  assert.deepEqual(await pixel(), [255, 0, 0, 255], "cross-origin images can be drawn");
  assert.deepEqual(await renderer.evaluate("[()=>ctx.getImageData(0,0,1,1),()=>canvas.toDataURL(),()=>canvas.toBlob(()=>{})].map(fn=>{try{fn();return 'allowed'}catch(error){return error.name}})"), ["SecurityError", "SecurityError", "SecurityError"]);
  await renderer.evaluate("copyCtx.drawImage(canvas,0,0,10,10)");
  assert.equal(await renderer.evaluate("(()=>{try{copy.toDataURL();return 'allowed'}catch(error){return error.name}})()"), "SecurityError", "taint follows canvas copies");
  await renderer.evaluate("canvas.width=100");
  assert.ok((await renderer.evaluate("canvas.toDataURL()")).startsWith("data:image/png;base64,"), "bitmap reset restores origin-clean state");
  await renderer.evaluate("img.crossOrigin='anonymous'");
  while (!await renderer.evaluate("img.complete && img.naturalWidth === 2")) { assert.ok(now() < deadline); await sleep(10); }
  assert.equal(corsRequests.length, 1, "changing crossorigin refetches with the CORS policy");
  assert.equal(corsRequests[0].mode, "cors");
  assert.equal(corsRequests[0].credentials, "same-origin");
  await renderer.evaluate("ctx.drawImage(img,0,0,100,150)");
  assert.deepEqual(await renderer.evaluate("[...ctx.getImageData(1,1,1,1).data]"), [255, 0, 0, 255], "CORS-approved foreign images keep the canvas clean");
  await renderer.evaluate("img.crossOrigin='use-credentials'");
  while (!await renderer.evaluate("img.complete && img.naturalWidth === 2")) { assert.ok(now() < deadline); await sleep(10); }
  assert.equal(corsRequests.at(-1).credentials, "include");
  await renderer.evaluate("img.src='https://foreign.test/denied.png'");
  while (!await renderer.evaluate("img.complete")) { assert.ok(now() < deadline); await sleep(10); }
  assert.equal(await renderer.evaluate("img.naturalWidth"), 0, "CORS-denied images cannot fall back to an unfiltered response");
  await renderer.evaluate("canvas.width=0");
  assert.equal(await renderer.evaluate("canvas.toDataURL()"), "data:,");
  await renderer.evaluate("canvas.style.width='';canvas.style.height=''");
  assert.deepEqual(renderer.inspect("canvas")[0].box, { x: 0, y: 0, width: 0, height: 150 });
  assert.deepEqual(await renderer.evaluate(`(() => {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const fill = () => { ctx.fillStyle = 'red'; ctx.fillRect(0,0,1,1); };
    const red = () => ctx.getImageData(0,0,1,1).data[0];
    const results = [];
    c.setAttribute('width', '20'); fill(); c.setAttribute('WIDTH', '20'); results.push(red());
    fill(); c.setAttributeNS('urn:test', 'test:width', '7'); results.push(red(), c.width);
    c.setAttributeNS(null, 'width', '30'); results.push(red(), c.width);
    fill(); c.removeAttributeNS(null, 'width'); results.push(red(), c.width);
    c.setAttribute('height', '10'); fill(); c.removeAttribute('height'); results.push(red(), c.height);
    fill(); c.toggleAttribute('width', false); results.push(red());
    c.toggleAttribute('width', true); results.push(red());
    c.setAttribute('width','10'); fill(); c.getAttributeNode('width').value='10'; results.push(red());
    const attr = c.getAttributeNode('width');
    fill(); c.removeAttribute('width'); results.push(red(), c.width);
    fill(); attr.value='15'; results.push(red(), c.width);
    return results;
  })()`), [0, 255, 20, 0, 30, 0, 300, 0, 150, 255, 0, 0, 0, 300, 255, 300], "all size-attribute APIs reset the bitmap; foreign/detached attributes and no-op removals do not");
  await renderer.loadDocument({ url: "https://canvas.test/next", contentType: "text/html", source: "<body style='margin:0'>next</body>" });
  await renderer.whenLoaded();
  // Prepaint and animation are independent timers. A canvas draw retires its
  // old native snapshot while a larger scrolled tile may still be queued.
  await renderer.loadDocument({ url: "https://canvas.test/animation", contentType: "text/html",
    source: `<body style="margin:0;height:5000px"><canvas id=a width=100 height=100 style="position:fixed;top:0;left:0"></canvas><script>
      const ctx=document.getElementById('a').getContext('2d');let tick=0;
      window.animation=setInterval(()=>{ctx.fillStyle=++tick%2?'red':'blue';ctx.fillRect(0,0,100,100)},17);
    </script>` });
  await renderer.whenLoaded();
  for (let i = 0; i < 20; i++) { renderer.scroll(0, i % 2 ? -110 : 110); await sleep(31); }
  await renderer.evaluate("clearInterval(animation)");
  const animated = await pixel(10, 10);
  assert.ok(animated[0] === 255 || animated[2] === 255);
} finally { renderer.dispose(); }

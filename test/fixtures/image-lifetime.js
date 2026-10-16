// Host scripting is isolated from the test runner's globals.
import { strict as assert } from "node:assert";
import { createPageRenderer, loadGraphics } from "../../lib/renderer/page-renderer.js";
import { encodeImage } from "../../lib/paint/frame.js";
const sleep = Bun.sleep;
const now = Date.now;
const { CanvasKit } = await loadGraphics();
const images = new Map();
for (const [name, color] of [["red", [255, 0, 0, 255]], ["blue", [0, 0, 255, 255]]]) {
  images.set(name, await encodeImage(new Uint8Array(Array.from({ length: 16 }, () => color).flat()), 4, 4));
}
const makeImage = CanvasKit.MakeImageFromEncoded;
let created = 0, alive = 0, frames = 0, fetched = 0;
const instrument = (image) => {
  if (!image) return image;
  created++; alive++;
  const remove = image.delete.bind(image), clone = image.clone.bind(image);
  image.delete = () => { alive--; remove(); };
  image.clone = () => instrument(clone());
  return image;
};
CanvasKit.MakeImageFromEncoded = bytes => instrument(makeImage(bytes));
let releaseLate;
const renderer = await createPageRenderer({
  onFrame: () => { frames++; },
  fetchResource: async url => {
    fetched++;
    if (url.includes("late")) await new Promise(resolve => { releaseLate = resolve; });
    return { ok: true, status: 200, url, body: images.get(url.includes("blue") ? "blue" : "red") };
  },
});
async function until(check) {
  const end = now() + 5000;
  while (!(await check())) { assert.ok(now() < end, "condition timed out"); await sleep(10); }
}
async function pixel() {
  const image = makeImage(Buffer.from(await renderer.screenshot(), "base64"));
  try { return [...image.readPixels(1, 1, { width: 1, height: 1, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB })]; }
  finally { image.delete(); }
}
try {
  renderer.resize(400, 300, 1);
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://images.test/", contentType: "text/html", source: '<body style="margin:0"></body>' });
  await renderer.whenLoaded();
  frames = 0;
  await renderer.evaluate(`window.saved = []; for (let i=0;i<100;i++) {
    const image=document.createElement('img'); image.width=image.height=20; image.src='/red.png';
    document.body.appendChild(image); saved.push(image);
  }`);
  await until(async () => await renderer.evaluate("saved.every(image => image.complete && image.naturalWidth === 4)"));
  await sleep(150);
  assert.equal(fetched, 1, "one network/IPC request for duplicate in-flight images");
  assert.equal(alive, 100, "independently-owned handles share one underlying image");
  assert.ok(frames < 10, `one arrival burst must not paint 100 frames: ${frames}`);
  assert.deepEqual(await pixel(), [255, 0, 0, 255]);
  await renderer.evaluate("saved[0].src='/blue.png'");
  await until(async () => await renderer.evaluate("saved[0].complete"));
  assert.deepEqual(await pixel(), [0, 0, 255, 255], "same-size replacement invalidates the raster cache");
  await renderer.evaluate("document.body.replaceChildren()");
  assert.equal(alive, 0, "removed images release native handles even when script retains DOM nodes");
  await renderer.evaluate("document.body.appendChild(saved[0])");
  await until(async () => await renderer.evaluate("saved[0].complete"));
  assert.equal(alive, 1, "reattaching a removed image reloads its resource");
  assert.deepEqual(await pixel(), [0, 0, 255, 255]);
  await renderer.evaluate("document.body.replaceChildren(); document.body.style.height='100px'");
  for (let i=0;i<8;i++) {
    await renderer.evaluate(`document.body.style.backgroundImage='url(/red-bg-${i}.png)'`);
    await until(() => alive === 1);
    await renderer.screenshot();
    assert.equal(alive, 1, "unused CSS background images are released");
  }
  await renderer.evaluate("document.body.style.backgroundImage='none'; saved[0].src='/late.png'; document.body.appendChild(saved[0])");
  await until(() => Boolean(releaseLate));
  renderer.dispose();
  const stopped = frames;
  const beforeLate = created;
  releaseLate();
  await until(() => created > beforeLate);
  await sleep(50);
  assert.equal(alive, 0, "late resources cannot revive a disposed renderer");
  assert.equal(frames, stopped);
  renderer.dispose();
  process.stdout.write("image lifetime integration passed\n");
} finally {
  releaseLate?.();
  renderer.dispose();
  CanvasKit.MakeImageFromEncoded = makeImage;
}

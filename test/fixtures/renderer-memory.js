import { strict as assert } from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import { createPageRenderer, loadGraphics } from '../../lib/renderer/page-renderer.js';

// Use the real WASM allocator: MakeSurface.delete() does not free its pixels.
// Each document needs an isolated realm: host scripting overwrites process
// globals and cannot be repeatedly installed for this lifetime stress test.
const { CanvasKit: kit } = await loadGraphics();
lockdown({ errorTaming: 'safe', overrideTaming: 'severe', consoleTaming: 'unsafe',
  localeTaming: 'unsafe', stackFiltering: 'concise', reporting: 'none' });
const malloc = kit._malloc, free = kit._free, makeSurface = kit.MakeSurface;
const allocations = new Map(), surfaces = new Set(), images = new Set();
const errors = [];
let reads = 0, failAt = Infinity;
kit._malloc = size => { const pointer = malloc(size); allocations.set(pointer, size); return pointer; };
kit._free = pointer => { allocations.delete(pointer); return free(pointer); };
kit.MakeSurface = (...args) => {
  const surface = makeSurface(...args);
  if (!surface) return surface;
  surfaces.add(surface);
  const dispose = surface.dispose.bind(surface), snapshot = surface.makeImageSnapshot.bind(surface);
  surface.dispose = () => { surfaces.delete(surface); return dispose(); };
  surface.makeImageSnapshot = (...args) => {
    const image = snapshot(...args), release = image.delete.bind(image), read = image.readPixels.bind(image);
    images.add(image);
    image.delete = () => { images.delete(image); return release(); };
    image.readPixels = (...args) => {
      if (++reads === failAt) throw new Error('intentional readback failure');
      return read(...args);
    };
    return image;
  };
  return surface;
};
const liveBytes = () => [...allocations.values()].reduce((sum, size) => sum + size, 0);
let warmBytes;
try {
  for (let cycle = 0; cycle < 8; cycle++) {
    const renderer = await createPageRenderer({
      fetchResource: async () => ({ ok: false, status: 404, body: new Uint8Array() }),
      reportError: error => errors.push(String(error)),
    });
    try {
      renderer.setScripting('ses');
      renderer.resize(400, 300, 1);
      await renderer.loadDocument({ url: 'https://memory.test/', contentType: 'text/html', source:
        `<canvas id="c" width="200" height="150"></canvas><p>Renderer lifecycle</p><script>
          window.c=document.getElementById('c');window.ctx=c.getContext('2d');
          ctx.fillStyle='blue';ctx.fillRect(0,0,200,150);
        </script>` });
      await renderer.whenLoaded();
      assert.equal(await renderer.evaluate("[...ctx.getImageData(1,1,1,1).data].join(',')"), '0,0,255,255');
      for (let step = 0; step < 6; step++) {
        renderer.resize(step % 2 ? 400 : 640, step % 2 ? 300 : 480, 1);
        await renderer.evaluate(`c.width=${200 + step};ctx.fillStyle='red';ctx.fillRect(0,0,200,150)`);
        assert.equal(await renderer.evaluate("[...ctx.getImageData(1,1,1,1).data].join(',')"), '255,0,0,255');
        await renderer.screenshot({ format: step % 2 ? 'jpeg' : 'png' });
      }
      await renderer.loadDocument({ url: 'https://memory.test/next', contentType: 'text/html', source: '<p>Next document</p>' });
      await renderer.whenLoaded();
      await renderer.screenshot();
    } finally { renderer.dispose(); }
    assert.deepEqual(errors, [], 'every document actually executes its canvas script');
    assert.equal(surfaces.size, 0, 'all software surface pixels are disposed');
    assert.equal(images.size, 0, 'all snapshots are deleted');
    warmBytes ??= liveBytes();
    assert.equal(liveBytes(), warmBytes, 'native allocations do not accumulate across renderer lifetimes');
  }

  const presentations = [];
  const renderer = await createPageRenderer({
    fetchResource: async () => ({ ok: true, status: 200, body: new Uint8Array([1]) }),
    reportError: error => errors.push(String(error)),
    videoDecoder: {
      probe: async () => ({ duration: 20, video: { width: 2, height: 2 } }),
      decode: async () => ({ width: 2, height: 2, fps: 10, seek() {}, close() {}, nextFrame: () => new Uint8Array(16).fill(255) }),
    },
    onVideo(message) { presentations.push(message.type); },
  });
  try {
    renderer.setScripting('ses');
    await renderer.loadDocument({ url: 'https://memory.test/video', contentType: 'text/html',
      source: '<video id="v" width="200" height="150" src="clip.mp4"></video>' });
    await renderer.whenLoaded();
    await renderer.evaluate("document.getElementById('v').play()");
    for (let attempt = 0; attempt < 50 && !presentations.includes('video-open'); attempt++) {
      await Bun.sleep(10);
      await renderer.screenshot();
    }
    assert.ok(presentations.includes('video-open'), 'video uses the separate presentation layer');
    assert.deepEqual(errors, []);
    await renderer.screenshot();
    // First read is the normal frame; second is the video overlay's base.
    failAt = reads + 2;
    assert.throws(() => renderer.resize(641, 481), /intentional readback failure/);
    assert.equal(reads, failAt, 'the video overlay readback was exercised');
    if (images.size !== 0) throw new Error(`failed overlay readback left ${images.size} snapshot(s) alive`);
  } finally { failAt = Infinity; renderer.dispose(); }
  assert.equal(surfaces.size, 0);
  assert.equal(images.size, 0);
  // Video MakeImage transfers its input allocation to C++; its eventual
  // native free does not call the JS _free wrapper. Check the owned surfaces
  // and snapshots here, rather than comparing that different allocation path
  // with the canvas-only baseline above.
  process.stdout.write('renderer memory lifecycle passed\n');
} finally {
  kit._malloc = malloc;
  kit._free = free;
  kit.MakeSurface = makeSurface;
}

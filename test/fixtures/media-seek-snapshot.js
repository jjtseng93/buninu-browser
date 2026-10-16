import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { createBytePipe } from '../../lib/media/byte-pipe.js';
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';

// Isolated because host scripting installs page globals in this process.
const sleep = Bun.sleep;
const bytes = await Bun.file(new URL('./mse-switch-small.mp4', import.meta.url)).bytes();
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
let prefixEnd = 0;
for (let offset = 0; offset + 8 <= bytes.length;) {
  const size = view.getUint32(offset);
  assert.ok(size >= 8 && offset + size <= bytes.length);
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (type === 'mdat') { prefixEnd = offset + size; break; }
  offset += size;
}
assert.ok(prefixEnd > 0 && prefixEnd < bytes.length);
await wasmpeg.load();
const expected = await wasmpeg.decode(bytes, { format: 'mp4' });
let expectedHash;
try {
  expected.seek(4000);
  expectedHash = Bun.hash(expected.nextFrame(64, 48));
} finally { expected.close(); }

const pipe = createBytePipe();
pipe.append(bytes.subarray(0, prefixEnd));
const openedSizes = [], drawnHashes = [], errors = [];
const renderer = await createPageRenderer({
  fetchResource: async () => ({ ok: true, contentType: 'video/mp4', body: pipe }),
  reportError: error => errors.push(String(error)),
  videoDecoder: {
    probe: (...args) => wasmpeg.probe(...args),
    async decode(snapshot, options) {
      openedSizes.push(snapshot.byteLength);
      const decoder = await wasmpeg.decode(snapshot, options);
      const nextFrame = decoder.nextFrame.bind(decoder);
      decoder.nextFrame = (width, height) => {
        const pixels = nextFrame(width, height);
        // Seek probes are 32x18; these are frames actually drawn by the page.
        if (pixels && width === 64 && height === 48) drawnHashes.push(Bun.hash(pixels));
        return pixels;
      };
      return decoder;
    },
  },
});
try {
  renderer.setScripting('host');
  await renderer.loadDocument({ url: 'https://seek.test/', contentType: 'text/html',
    source: '<video id="v" width="64" height="48" src="clip.mp4"></video>' });
  const seek = seconds => renderer.evaluate(`new Promise(resolve => {
    const video = document.getElementById('v');
    video.addEventListener('seeked', () => resolve(true), { once: true });
    video.currentTime = ${seconds};
  })`);
  await seek(0);
  assert.equal(openedSizes.at(-1), prefixEnd);
  assert.notEqual(drawnHashes.at(-1), expectedHash);
  const firstHash = drawnHashes.at(-1);
  const oldOpens = openedSizes.length;
  pipe.append(bytes.subarray(prefixEnd));
  pipe.finish();
  for (let attempt = 0; attempt < 100 && await renderer.evaluate("document.getElementById('v').duration") < 6; attempt++) await sleep(10);
  assert.equal(await renderer.evaluate("document.getElementById('v').duration"), 6);
  await seek(5);
  assert.ok(openedSizes.length > oldOpens, 'seeking beyond an old prefix opens the latest snapshot');
  assert.equal(openedSizes.at(-1), bytes.length);
  assert.equal(drawnHashes.at(-1), expectedHash, 'the seek draws the target keyframe, not the stale prefix');
  const currentOpens = openedSizes.length;
  await seek(1);
  assert.equal(openedSizes.length, currentOpens, 'a current snapshot remains reusable for backward seeking');
  assert.equal(drawnHashes.at(-1), firstHash);
  assert.deepEqual(errors, []);
  process.stdout.write('latest video snapshot seek passed\n');
} finally { renderer.dispose(); }

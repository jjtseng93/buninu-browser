// Isolated because host scripting installs browser globals in this process.
import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";

const sleep = Bun.sleep;
const success = () => process.stdout.write("media clock integration passed\n");
let output, frames = 0, samples = 0;
const errors = [];
const renderer = await createPageRenderer({
  fetchResource: async () => ({ ok: true, body: new Uint8Array([1]), contentType: "video/mp4" }),
  reportError: error => errors.push(String(error)),
  videoDecoder: {
    probe: async () => ({ duration: 10, video: { width: 2, height: 2 }, audio: { sampleRate: 1000 } }),
    decode: async () => ({ width: 2, height: 2, fps: 10,
      nextFrame(w, h) { frames++; return new Uint8Array(w * h * 4); }, seek() {}, close() {} }),
    decodeAudio: async () => ({ sampleRate: 1000, channels: 1,
      nextSamples() { return new Float32Array(100); }, close() {} }),
  },
  audio: {
    open(options, listener) { output = listener; return 1; },
    write(id, bytes) { samples += bytes.length / 2; },
    close() { return Promise.resolve(samples * 2); },
    finish() {},
  },
});
try {
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://media.test/", source: '<video id="v" src="clip.mp4"></video>', contentType: "text/html" });
  await renderer.evaluate("document.getElementById('v').play()");
  output({ event: "request", bytes: 1000 });
  assert.equal(samples, 500);
  await sleep(180);
  assert.equal(await renderer.evaluate("document.getElementById('v').currentTime"), 0,
    "queued samples are not played samples");
  const firstFrames = frames;
  await sleep(180);
  assert.equal(frames, firstFrames, "video cannot outrun an audio device which hasn't started");
  output({ event: "timing", seconds: 0.2, sentSeconds: 0.5, sinkSeconds: 0.3 });
  await sleep(160);
  assert.equal(await renderer.evaluate("document.getElementById('v').currentTime"), 0.2);
  const stalledFrames = frames;
  await sleep(300);
  assert.equal(frames, stalledFrames, "no clock advance through missing feedback/network starvation");
  assert.equal(await renderer.evaluate("document.getElementById('v').currentTime"), 0.2);
  output({ event: "timing", seconds: 0.4, sentSeconds: 0.5, sinkSeconds: 0.1 });
  await sleep(160);
  assert.equal(await renderer.evaluate("document.getElementById('v').currentTime"), 0.4);
  assert.ok(frames > stalledFrames, "frames resume only with measured audio progress");
  await renderer.evaluate("document.getElementById('v').pause()");
  output({ event: "timing", seconds: 0.5, sentSeconds: 0.5, sinkSeconds: 0 });
  assert.equal(await renderer.evaluate("document.getElementById('v').currentTime"), 0.4,
    "late feedback from a closed stream cannot move a paused element");
  assert.deepEqual(errors, []);
  success();
} finally {
  renderer.dispose();
}

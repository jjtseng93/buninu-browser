// Isolated: the host realm installs browser globals in this process.
import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { createBytePipe } from '../../lib/media/byte-pipe.js';

const scenario = process.argv[2], sleep = Bun.sleep, pipe = createBytePipe();
pipe.append(new Uint8Array(1024));
const decoders = [], messages = [], errors = [], outputs = [];
let holdNext = false, finishOpen, changeFormat = false;
if (scenario === 'epoch') pipe.snapshotAt = time => ({
  bytes: pipe.bytes(), id: pipe.generation > 1 && time >= 2 ? 'b' : 'a',
  startTime: pipe.generation > 1 && time >= 2 ? 2 : 0,
  endTime: pipe.generation > 1 && time < 2 ? 2 : Infinity,
});
const renderer = await createPageRenderer({
  onFrame() {}, onVideo: message => messages.push(message),
  fetchResource: async () => ({ ok: true, contentType: 'video/mp4', body: pipe }),
  reportError: error => errors.push(String(error)),
  videoDecoder: {
    probe: async () => ({ duration: 30, video: { width: 20, height: 12 }, audio: { sampleRate: 1000 } }),
    async decode() {
      const record = { seeks: [], frames: 0, at: 0, closed: 0 };
      const decoder = {
        width: changeFormat ? 21 : 20, height: 12, fps: 10,
        seek(ms) { record.seeks.push(ms); record.at = Math.floor(ms / 1000); },
        nextFrame(w, h) {
          record.frames++;
          const bytes = new Uint8Array(w * h * 4).fill(20 + Math.floor(record.at));
          record.at += 0.1;
          return bytes;
        },
        close() { record.closed++; },
      };
      changeFormat = false;
      decoders.push(record);
      if (holdNext) { holdNext = false; await new Promise(resolve => { finishOpen = resolve; }); }
      return decoder;
    },
    decodeAudio: async () => ({ sampleRate: 1000, channels: 1,
      nextSamples: () => new Float32Array(100), close() {} }),
  },
  audio: {
    open(options, listener) { outputs.push({ listener, samples: 0 }); return outputs.length; },
    write(id, bytes) { outputs[id - 1].samples += bytes.length / 2; },
    close(id) { return Promise.resolve(outputs[id - 1].samples * 2); },
    finish() {},
  },
});
const typed = type => messages.filter(message => message.type === type);
const waitFor = async condition => {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await sleep(5); }
  assert.fail(`transition timed out (${scenario}): ${condition}; ${JSON.stringify({
    messages: messages.map(({ type, id, revision }) => ({ type, id, revision })), decoders, errors,
  })}`);
};
const evaluate = code => renderer.evaluate(code);
const waiting = () => evaluate('globalThis.waitingEvents');
try {
  renderer.resize(240, 180, 1);
  renderer.setScripting('host');
  await renderer.loadDocument({ url: 'https://continuation.test/', contentType: 'text/html', source:
    '<style>body{margin:0}video{width:100px;height:60px;display:block}</style><video id=v src="clip.mp4"></video>' });
  await renderer.whenLoaded();
  await evaluate('globalThis.waitingEvents=0;globalThis.v=document.getElementById("v");v.addEventListener("waiting",()=>waitingEvents++);v.play()');
  outputs.at(-1).listener({ event: 'request', bytes: 20000 });
  await waitFor(() => typed('video-open').length === 1);
  const first = typed('video-open')[0], initial = decoders[0], beforeWaiting = await waiting();
  outputs[0].listener({ event: 'timing', seconds: 1.5, sentSeconds: 10, sinkSeconds: 8.5 });
  if (scenario !== 'no-growth') pipe.append(new Uint8Array(1024));
  if (scenario === 'epoch' || scenario === 'no-growth') {
    renderer.videoReport({ id: first.id, revision: 0, exhaustedAt: 2 });
    await sleep(20);
    assert.equal(typed('video-extend').length, 0);
    assert.equal(decoders.length, 1, 'no speculative decoder for unavailable bytes/new epoch');
    renderer.videoReport({ id: first.id, revision: 0, end: 2 });
    await waitFor(() => typed('video-open').length > 1);
    assert.equal(await waiting(), beforeWaiting + 1);
  } else {
    holdNext = true;
    changeFormat = scenario === 'format';
    renderer.videoReport({ id: first.id, revision: 0, exhaustedAt: 2 });
    await waitFor(() => Boolean(finishOpen));
    const staged = decoders.at(-1);
    renderer.videoReport({ id: first.id, revision: 0, end: 2 });
    renderer.videoReport({ id: first.id, revision: 0, exhaustedAt: 2 });
    assert.equal(decoders.length, 2, 'one staged decoder');
    assert.equal(await waiting(), beforeWaiting, 'queued EOF does not dispatch waiting');
    assert.equal(typed('video-stop').length, 0);
    if (scenario === 'pause' || scenario === 'controls' || scenario === 'seek' || scenario === 'source') {
      const action = { pause: 'v.pause()', controls: 'v.setAttribute("controls","");v.style.width="101px"',
        seek: 'v.currentTime=4', source: 'v.src="different.mp4";v.load()' }[scenario];
      await evaluate(action);
      await waitFor(() => typed('video-stop').length > 0);
      finishOpen();
      await waitFor(() => staged.closed === 1);
      assert.equal(typed('video-extend').length, 0, 'canceled source/position/layout never extends');
      assert.equal(staged.closed, 1);
    } else {
      finishOpen();
      if (scenario === 'format') {
        await waitFor(() => typed('video-open').length > 1);
        assert.equal(staged.closed, 1);
        assert.equal(typed('video-extend').length, 0);
        assert.equal(await waiting(), beforeWaiting + 1);
      } else {
        await waitFor(() => typed('video-extend').length === 1);
        const extension = typed('video-extend')[0];
        assert.equal(extension.id, first.id);
        assert.equal(extension.revision, 0);
        assert.equal(extension.boundary, 2);
        assert.equal(extension.generation, 2);
        assert.equal(extension.bytes.length, 2048);
        if (scenario === 'worker-failure') {
          renderer.videoReport({ id: first.id, revision: 0, continuationError: 'decoder rejected snapshot' });
          await waitFor(() => typed('video-open').length > 1);
          assert.equal(staged.closed, 1);
          assert.equal(await waiting(), beforeWaiting + 1);
        } else {
          renderer.videoReport({ id: first.id, revision: 1, continued: 2 });
          assert.equal(initial.closed, 1, 'old lazy decoder released after ACK');
          assert.equal(staged.closed, 0);
          renderer.videoReport({ id: first.id, revision: 0, end: 2 });
          renderer.videoReport({ id: first.id, revision: 0, exhaustedAt: 2 });
          await sleep(20);
          assert.equal(typed('video-open').length, 1);
          assert.equal(typed('video-stop').length, 0);
          assert.equal(await waiting(), beforeWaiting);
          assert.equal(outputs.length, 1, 'same measured audio stream');
          assert.equal(await evaluate('v.currentTime'), 1.5);
          // Local fallback must use the newly opened snapshot, positioned lazily.
          renderer.videoReport({ id: first.id, error: 'simulated worker close' });
          await waitFor(() => staged.frames > 0);
          assert.ok(staged.seeks.length > 0);
          assert.equal(initial.frames, 1);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`continuation ${scenario} passed\n`);
} finally { renderer.dispose(); }

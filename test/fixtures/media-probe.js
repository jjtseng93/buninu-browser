// Isolated: the host realm installs browser globals in this process.
import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';

const scenario = process.argv[2], sleep = Bun.sleep;
const probes = [], pending = [], errors = [];
let hold = scenario.startsWith('initial') && scenario !== 'initial-rejected';
let failNext = scenario === 'initial-rejected';
const renderer = await createPageRenderer({
  reportError: error => errors.push(String(error)),
  fetchResource: async () => ({ ok: true, contentType: 'video/mp4', body: new Uint8Array(8) }),
  videoDecoder: {
    async probe(bytes) {
      const input = { length: bytes.length, hash: Bun.hash(bytes).toString() };
      probes.push(input);
      if (failNext) { failNext = false; throw Error('temporary probe failure'); }
      if (hold) return new Promise(resolve => pending.push(resolve));
      return metadata(bytes.length);
    },
    decode: async () => ({ width: 20, height: 12, fps: 1, close() {}, seek() {},
      nextFrame: (w, h) => new Uint8Array(w * h * 4) }),
  },
});
const metadata = duration => ({ duration, video: { width: 20, height: 12 } });
const evaluate = code => renderer.evaluate(code);
const waitFor = async condition => {
  for (let attempt = 0; attempt < 150; attempt++) { if (await condition()) return; await sleep(5); }
  assert.fail(`probe transition timed out: ${scenario}; ${JSON.stringify({ probes, pending: pending.length, errors })}`);
};
const append = buffer => evaluate(`new Promise(resolve => {
  ${buffer}.addEventListener('updateend', resolve, {once:true});
  ${buffer}.appendBuffer(new Uint8Array([0,0,0,8,102,114,101,101]));
})`);
const count = () => evaluate('metadataEvents');
const duration = () => evaluate('v.duration');
const finishInitial = async () => {
  await waitFor(async () => await count() === 1);
  await evaluate('v.pause()');
  await sleep(10);
};
try {
  renderer.setScripting('host'); renderer.resize(240, 180, 1);
  await renderer.loadDocument({ url: 'https://probe.test/', contentType: 'text/html',
    source: '<!doctype html><video id="v"></video>' });
  await renderer.whenLoaded();
  await evaluate(`new Promise(resolve => {
    globalThis.metadataEvents=0; globalThis.v=document.getElementById('v');
    v.addEventListener('loadedmetadata',()=>metadataEvents++);
    globalThis.ms=new MediaSource();
    ms.addEventListener('sourceopen',()=>{
      globalThis.vb=ms.addSourceBuffer('video/mp4');
      globalThis.ab=ms.addSourceBuffer('audio/mp4');
      globalThis.probeWaits=0;
      { const pipe=ms.streamPipes().video, original=pipe.waitFor;
        pipe.waitFor=mark=>{probeWaits++;return original(mark)}; }
      ${scenario.startsWith('epoch') ? `const pipe=ms.streamPipes().video, original=pipe.snapshotAt;
      pipe.snapshotAt=seconds=>({...original(seconds),id:seconds>=2?'late':'early'});` : ''}
      ${scenario === 'moving-snapshot' ? `const pipe=ms.streamPipes().video, original=pipe.snapshotAt;
      pipe.snapshotAt=seconds=>({...original(seconds),startTime:Math.floor(seconds/0.02)*0.02});` : ''}
      void v.play(); resolve();
    },{once:true});
    v.src=URL.createObjectURL(ms);
  })`);
  await append('vb');
  if (scenario === 'initial-rejected') {
    await waitFor(() => probes.length === 1);
    await sleep(10);
    const waits = await evaluate('probeWaits');
    for (let i = 0; i < 5; i++) await append('ab');
    await sleep(15);
    assert.equal(probes.length, 1, 'unchanged rejected initial bytes wait for video growth');
    assert.equal(await evaluate('probeWaits'), waits, 'audio appends do not accumulate pending video waiters');
    await append('vb'); await finishInitial();
    assert.equal(probes.length, 2); assert.equal(await count(), 1);
  } else if (scenario.startsWith('initial')) {
    await waitFor(() => pending.length === 1);
    await append('ab'); await append('ab'); await sleep(15);
    assert.equal(probes.length, 1, 'loadMedia and first append share one initial probe');
    if (scenario === 'initial-growth') {
      await append('vb'); await append('vb');
      pending.shift()(metadata(8));
      await waitFor(() => pending.length === 1);
      assert.equal(probes.length, 2, 'one latest-input recheck after coalesced appends');
      assert.equal(await count(), 0, 'obsolete initial input cannot publish metadata');
      hold = false; pending.shift()(metadata(24));
      await finishInitial(); assert.equal(await duration(), 24);
    } else if (scenario === 'initial-source') {
      await evaluate('v.src="replacement.mp4";v.load()');
      hold = false; pending.shift()(metadata(123));
      await sleep(25); assert.equal(await count(), 1);
      assert.equal(await duration(), 8, 'only the replacement source can publish metadata');
    } else {
      hold = false; pending.shift()(metadata(8));
      await finishInitial(); assert.equal(await count(), 1);
      await append('ab'); await sleep(15);
      assert.equal(probes.length, 1, 'initial probe does not leave a blocked duplicate waiter');
    }
  } else {
    await finishInitial(); assert.equal(probes.length, 1);
    if (scenario === 'audio-only') {
      await append('vb'); await waitFor(() => probes.length === 2);
      for (let i = 0; i < 5; i++) await append('ab');
      await sleep(20); assert.equal(probes.length, 2, 'audio appends reuse unchanged video metadata');
      assert.equal(await count(), 1);
    } else if (scenario === 'refresh-growth' || scenario === 'pipe-change') {
      hold = true; await append('vb'); await waitFor(() => pending.length === 1);
      if (scenario === 'pipe-change') await evaluate('ms.removeSourceBuffer(vb);globalThis.vb=ms.addSourceBuffer("video/mp4")');
      await append('vb'); await append('vb');
      assert.equal(probes.length, 2, 'no parallel refresh');
      pending.shift()(metadata(20));
      await waitFor(() => pending.length === 1);
      assert.equal(probes.length, 3); assert.equal(await duration(), 8, 'stale pipe/generation cannot overwrite metadata');
      hold = false; pending.shift()(metadata(40));
      await waitFor(async () => await duration() === 40);
      assert.equal(await count(), 1);
    } else if (scenario === 'failed-retry') {
      failNext = true; await append('vb'); await waitFor(() => probes.length === 2);
      await append('ab'); await waitFor(() => probes.length === 3);
      assert.deepEqual(probes[1], probes[2], 'same failed snapshot is retryable');
      await append('ab'); await sleep(15); assert.equal(probes.length, 3);
    } else if (scenario === 'mime-change') {
      await evaluate('vb.changeType("video/webm")'); await append('ab');
      await waitFor(() => probes.length === 2);
      assert.deepEqual(probes[0], probes[1], 'MIME change invalidates identical byte input');
    } else if (scenario === 'epoch-inflight') {
      hold = true; await append('vb'); await waitFor(() => pending.length === 1);
      await evaluate('v.currentTime=3'); pending.shift()(metadata(20));
      await waitFor(() => pending.length === 1);
      assert.equal(probes.length, 3);
      assert.equal(await duration(), 8, 'seek to another epoch rejects old in-flight metadata');
      hold = false; pending.shift()(metadata(40));
      await waitFor(async () => await duration() === 40);
    } else if (scenario === 'moving-snapshot') {
      hold = true; await append('vb'); await waitFor(() => pending.length === 1);
      await evaluate('v.currentTime=3');
      hold = false; pending.shift()(metadata(20));
      await waitFor(async () => await duration() === 20);
      await sleep(20);
      assert.equal(probes.length, 2, 'clock movement alone cannot restart an in-flight snapshot probe');
    } else if (scenario === 'epoch') {
      await evaluate('v.currentTime=3'); await sleep(20); await append('ab');
      await waitFor(() => probes.length === 2);
      assert.deepEqual(probes[0], probes[1], 'snapshot epoch invalidates identical bytes and generation');
    }
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`media probe ${scenario} passed\n`);
} finally { renderer.dispose(); }

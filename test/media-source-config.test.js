import { beforeAll, expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { createMediaSourceScope } from '../lib/renderer/media-source.js';

// These synthetic fMP4 fixtures were generated from ffmpeg's testsrc2 filter:
// 6 seconds, 10 fps, x264/yuv420p, 2-second GOPs, fragmented empty-moov MP4;
// dimensions are 64x48 and 128x96. They contain no third-party media.
let small, large;
beforeAll(async () => {
  await wasmpeg.load();
  [small, large] = await Promise.all(['small', 'large'].map(async name =>
    new Uint8Array(await Bun.file(new URL(`./fixtures/mse-switch-${name}.mp4`, import.meta.url)).arrayBuffer())));
});
function visit(bytes, callback, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let offset = from; offset + 8 <= to;) {
    const size = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > to) break;
    callback(type, offset + 8, offset + size, offset);
    if (['moov', 'trak', 'mdia', 'moof', 'traf'].includes(type)) visit(bytes, callback, offset + 8, offset + size);
    offset += size;
  }
}
function shifted(original, seconds) {
  const bytes = original.slice(), view = new DataView(bytes.buffer);
  let timescale;
  visit(bytes, (type, data) => { if (type === 'mdhd') timescale = view.getUint32(data + (bytes[data] ? 20 : 12)); });
  visit(bytes, (type, data) => {
    if (type !== 'tfdt') return;
    if (bytes[data]) view.setBigUint64(data + 4, view.getBigUint64(data + 4) + BigInt(seconds * timescale));
    else view.setUint32(data + 4, view.getUint32(data + 4) + seconds * timescale);
  });
  return bytes;
}
function context() {
  const tasks = [], scope = createMediaSourceScope({ origin: 'https://media.test', schedule: task => tasks.push(task), DOMException });
  const flush = () => { while (tasks.length) tasks.shift()(); };
  const source = new scope.MediaSource(); source.attach('blob:https://media.test/clip'); flush();
  const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.64000a"');
  return { source, pipe: buffer._pipe, append(bytes) { buffer.appendBuffer(bytes); flush(); } };
}
async function frameHashes(bytes) {
  const decoder = await wasmpeg.decode(bytes, { format: 'mp4' }), hashes = [];
  try { for (let frame; (frame = decoder.nextFrame(128, 96));) hashes.push(Bun.hash(frame)); }
  finally { decoder.close(); }
  return hashes;
}

test('MSE configuration changes preserve every frame and allow backward selection across A-B-A epochs', async () => {
  const c = context(), second = shifted(large, 6), third = shifted(small, 12);
  c.append(small); c.append(second); c.append(third); c.source.endOfStream();
  const a = c.pipe.snapshotAt(2), b = c.pipe.snapshotAt(8), a2 = c.pipe.snapshotAt(14);
  expect([a.startTime, a.endTime, b.startTime, b.endTime, a2.startTime, a2.endTime]).toEqual([0, 6, 6, 12, 12, Infinity]);
  expect(new Set([a.id, b.id, a2.id]).size).toBe(3);
  expect(await frameHashes(a.bytes)).toEqual(await frameHashes(small));
  expect(await frameHashes(b.bytes)).toEqual(await frameHashes(second));
  expect(await frameHashes(a2.bytes)).toEqual(await frameHashes(third));
  expect(await frameHashes(c.pipe.snapshotAt(1).bytes)).toEqual(await frameHashes(small));
});

test('identical init retries do not create an epoch or duplicate media, while split init headers remain usable', async () => {
  const c = context();
  let initEnd;
  visit(small, (type, data, end) => { if (type === 'moov') initEnd = end; });
  c.append(small.subarray(0, initEnd));
  const pendingId = c.pipe.snapshotAt(0).id;
  c.append(small.subarray(0, initEnd));
  expect(c.pipe.snapshotAt(0).id).toBe(pendingId);
  for (let offset = 0; offset < small.length; offset += 37) c.append(small.subarray(offset, offset + 37));
  const initial = c.pipe.snapshotAt(2);
  c.append(small);
  const retry = c.pipe.snapshotAt(2);
  expect(retry.id).toBe(initial.id);
  expect(retry.endTime).toBe(Infinity);
  expect(await frameHashes(retry.bytes)).toEqual(await frameHashes(small));
});

test('overlapping replacement fragments are deduplicated only within their initialization', async () => {
  const c = context(); c.append(small);
  const second = shifted(large, 2); c.append(second);
  expect(c.pipe.snapshotAt(1).endTime).toBe(2);
  expect(c.pipe.snapshotAt(3).startTime).toBe(2);
  expect(await frameHashes(c.pipe.snapshotAt(3).bytes)).toEqual(await frameHashes(second));
});

test('ordinary MP4 including a zero-sized final mdat keeps its complete bytes across appends', async () => {
  const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/video.mp4', import.meta.url)).arrayBuffer());
  const expected = await frameHashes(bytes);
  for (const zeroSized of [false, true]) {
    const input = bytes.slice();
    if (zeroSized) visit(input, (type, data, end, offset) => { if (type === 'mdat') new DataView(input.buffer).setUint32(offset, 0); });
    const c = context();
    for (let offset = 0; offset < input.length; offset += 113) c.append(input.subarray(offset, offset + 113));
    c.source.endOfStream();
    expect(c.pipe.snapshotAt(0).bytes).toEqual(input);
    expect(await frameHashes(c.pipe.snapshotAt(0).bytes)).toEqual(expected);
  }
});

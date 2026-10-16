import { beforeAll, expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { floatToS16 } from '../lib/audio/pcm.js';
import { createMediaSourceScope } from '../lib/renderer/media-source.js';
import { createWebMStream, ebmlHeader } from '../lib/media/webm-stream.js';

// Self-generated eight-second chirp, 48 kHz mono Opus, 2-second Clusters.
// Unlike a constant tone, its PCM identifies a repeated earlier segment.
let fixture, elements;
beforeAll(async () => {
  await wasmpeg.load();
  fixture = new Uint8Array(await Bun.file(new URL('./fixtures/mse-audio-chirp.webm', import.meta.url)).arrayBuffer());
  elements = createWebMStream().append(fixture);
});
function context() {
  const tasks = [], scope = createMediaSourceScope({ origin: 'https://media.test', schedule: task => tasks.push(task), DOMException });
  const flush = () => { while (tasks.length) tasks.shift()(); };
  const source = new scope.MediaSource(); source.attach('blob:https://media.test/audio'); flush();
  const buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
  return { source, buffer, append(bytes) { buffer.appendBuffer(bytes); flush(); } };
}
const concat = parts => new Uint8Array(Bun.concatArrayBuffers(parts));
async function pcm(bytes) {
  const decoder = await wasmpeg.decodeAudio(bytes, { format: 'webm' }), parts = [];
  try { for (let samples; (samples = decoder.nextSamples());) parts.push(floatToS16(samples)); }
  finally { decoder.close(); }
  return concat(parts);
}
const cluster = element => element.id === 0x1f43b675;

test('split WebM Clusters, whole retries, and mixed old/new appends preserve exact chronological PCM', async () => {
  const c = context(), groups = elements.filter(cluster), init = concat(elements.slice(0, elements.indexOf(groups[0])).map(e => e.bytes));
  expect(groups.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < init.length; i += 7) c.append(init.subarray(i, i + 7));
  const first = groups[0].bytes;
  // This was the live failure: a partial first Cluster understated coverage,
  // and a later whole retry inserted its opening PCM after the second one.
  for (let i = 0; i < first.length; i += 137) c.append(first.subarray(i, i + 137));
  c.append(groups[1].bytes);
  const beforeRetry = c.buffer._pipe.size;
  c.append(first);
  expect(c.buffer._pipe.size).toBe(beforeRetry);
  c.append(concat([groups[0].bytes, groups[2].bytes]));
  for (const element of elements.slice(elements.indexOf(groups[3]))) c.append(element.bytes);
  c.source.endOfStream();
  const actual = await pcm(c.buffer._pipe.bytes()), reference = await pcm(fixture);
  expect(actual.length).toBe(reference.length);
  expect(Bun.hash(actual)).toBe(Bun.hash(reference));
  expect(c.buffer.buffered.end(0)).toBeGreaterThanOrEqual(8);
  expect(c.buffer.buffered.end(0)).toBeLessThan(8.1);
  expect(Bun.hash(actual.subarray(0, 48000 * 2))).not.toBe(Bun.hash(actual.subarray(4 * 48000 * 2, 5 * 48000 * 2)));
});

test('unknown-size live Clusters expose complete Blocks before the next Cluster and deduplicate retried Blocks', async () => {
  const c = context(), groups = elements.filter(cluster);
  for (const element of elements.slice(0, elements.indexOf(groups[0]))) c.append(element.bytes);
  let initialSize = c.buffer._pipe.size;
  for (const group of groups) {
    const header = ebmlHeader(group.bytes), idLength = 4;
    const live = group.bytes.slice();
    // Preserve the original VINT width while replacing its value with unknown.
    live[idLength] = (1 << (9 - (header.length - idLength))) - 1;
    live.fill(0xff, idLength + 1, header.length);
    for (let i = 0; i < live.length; i += 101) c.append(live.subarray(i, i + 101));
    expect(c.buffer._pipe.size).toBeGreaterThan(initialSize);
    initialSize = c.buffer._pipe.size;
    // The next header closes the previous unknown Cluster. Its old Blocks
    // must not be played again even though no finite size was available.
    c.append(live);
    expect(c.buffer._pipe.size).toBe(initialSize);
  }
  c.source.endOfStream();
  const actual = await pcm(c.buffer._pipe.bytes()), reference = await pcm(fixture);
  expect(actual.length).toBe(reference.length);
  expect(Bun.hash(actual)).toBe(Bun.hash(reference));
});

test('EBML framing never treats packet payload bytes as Cluster boundaries', () => {
  const stream = createWebMStream();
  const bytes = Uint8Array.from([
    0x1f, 0x43, 0xb6, 0x75, 0xff, // unknown Cluster
    0xe7, 0x81, 0,
    0xa3, 0x89, 0x81, 0, 0, 0, 0x1f, 0x43, 0xb6, 0x75, 0,
  ]);
  const emitted = [];
  for (const byte of bytes) emitted.push(...stream.append(Uint8Array.of(byte)));
  expect(emitted.length).toBe(1);
  expect(emitted[0].cluster.time).toBe(0);
  expect([...emitted[0].bytes]).toEqual([...bytes.subarray(8)]);
  // The standalone framer still owns the prefix until a consumer accepts
  // the Block (SourceBuffer records that on the shared cluster token).
  expect(stream.pendingSize).toBe(8);
  stream.reset();
  expect(stream.pendingSize).toBe(0);
});

test('incremental muxed Clusters retain different tracks at the same presentation time', () => {
  const c = context();
  const bytes = Uint8Array.from([
    0x1f, 0x43, 0xb6, 0x75, 0xff, 0xe7, 0x81, 0,
    0xa3, 0x85, 0x81, 0, 0, 0, 1,
    0xa3, 0x85, 0x82, 0, 0, 0, 2,
  ]);
  c.append(bytes);
  expect([...c.buffer._pipe.bytes()]).toEqual([...bytes]);
  c.append(bytes);
  expect([...c.buffer._pipe.bytes()]).toEqual([...bytes]);
});

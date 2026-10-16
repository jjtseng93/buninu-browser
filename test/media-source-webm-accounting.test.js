import { expect, test } from "bun:test";
import { createMediaSourceScope } from "../lib/renderer/media-source.js";

function context(appendQuota = 1000) {
  const tasks = [];
  const media = createMediaSourceScope({
    origin: "https://media.test", DOMException, appendQuota,
    schedule: task => tasks.push(task),
  });
  const flush = () => { while (tasks.length) tasks.shift()(); };
  const source = new media.MediaSource();
  source.attach("blob:https://media.test/audio");
  flush();
  const buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
  const append = bytes => { buffer.appendBuffer(bytes); flush(); };
  return { source, buffer, flush, append };
}

// One finite Cluster, timecode 0, with a SimpleBlock at 1000 ms.
const cluster = Uint8Array.from([
  0x1f, 0x43, 0xb6, 0x75, 0x8a, 0xe7, 0x81, 0x00,
  0xa3, 0x85, 0x81, 0x03, 0xe8, 0x00, 0x00,
]);
const header = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);

test("idle abort discards an incomplete WebM element before the next initialization", () => {
  const { buffer, flush, append } = context();
  append(cluster.subarray(0, 7));
  expect(buffer._pipe.size).toBe(0);
  const events = [];
  buffer.addEventListener("abort", () => events.push("abort"));
  buffer.addEventListener("updateend", () => events.push("updateend"));
  buffer.abort();
  flush();
  expect(buffer._accountedBytes).toBe(0);
  expect(events).toEqual([]);
  const next = new Uint8Array(Bun.concatArrayBuffers([header, cluster]));
  append(next);
  expect(buffer._pipe.bytes()).toEqual(next);
  expect(buffer.buffered.end(0)).toBeCloseTo(1.02, 5);
});

test("abort cancels a queued WebM append and clears a previous incomplete element", () => {
  const { buffer, flush, append } = context();
  append(cluster.subarray(0, 7));
  const events = [];
  buffer.addEventListener("abort", () => events.push("abort"));
  buffer.addEventListener("updateend", () => events.push("updateend"));
  buffer.appendBuffer(cluster.subarray(7));
  buffer.abort();
  flush();
  expect(buffer.updating).toBe(false);
  expect(buffer._accountedBytes).toBe(0);
  expect(buffer._pipe.size).toBe(0);
  expect(events).toEqual(["abort", "updateend"]);
  append(cluster);
  expect(buffer._pipe.bytes()).toEqual(cluster);
});

test("a split retry completed after eviction cannot refund another buffer's quota", () => {
  const { source, buffer, flush, append } = context(100);
  const other = source.addSourceBuffer('audio/webm; codecs="opus"');
  // An independent 50-byte Void element reserves the other buffer's quota.
  const padding = new Uint8Array(50);
  padding.set([0xec, 0xb0]);
  other.appendBuffer(padding);
  flush();
  append(cluster);
  append(cluster.subarray(0, 7));
  buffer.remove(0, 2);
  flush();
  append(cluster.subarray(7));
  expect(buffer._accountedBytes).toBe(0);
  expect(other._accountedBytes).toBe(50);
  expect(buffer._pipe.bytes()).toEqual(cluster);
  expect(() => buffer.appendBuffer(new Uint8Array(51))).toThrow("The SourceBuffer is full.");
});

test("repeated unknown Clusters retain only the current unused prefix until abort or EOF", () => {
  for (const finish of ["abort", "endOfStream"]) {
    const { source, buffer, append } = context();
    const live = cluster.slice();
    live[4] = 0xff;
    append(live);
    expect(buffer._accountedBytes).toBe(live.length);
    for (let retry = 0; retry < 3; retry++) {
      append(live);
      // The current prefix remains necessary if a later Block is new.
      expect(buffer._webmStream.pendingSize).toBe(8);
      expect(buffer._accountedBytes).toBe(live.length + 8);
      expect(buffer._pipe.bytes()).toEqual(live);
    }
    if (finish === "abort") buffer.abort();
    else source.endOfStream();
    expect(buffer._webmStream.pendingSize).toBe(0);
    expect(buffer._accountedBytes).toBe(live.length);
  }
});

import { expect, test } from "bun:test";
import { createMediaSourceScope } from "../lib/renderer/media-source.js";

function scope(options = {}) {
  const tasks = [];
  const media = createMediaSourceScope({
    origin: "https://page.test",
    schedule: (task) => tasks.push(task),
    DOMException,
    ...options,
  });
  const flush = () => {
    while (tasks.length) tasks.shift()();
  };
  return { media, flush };
}

function openBuffer(context) {
  const source = new context.media.MediaSource();
  source.attach("blob:https://page.test/media");
  context.flush();
  return { source, buffer: source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"') };
}

function box(type, ...parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function fragmentedMp4Pieces() {
  const mdhd = new Uint8Array(20);
  new DataView(mdhd.buffer).setUint32(12, 1000);
  const init = box("moov", box("trak", box("mdia", box("mdhd", mdhd))));
  const segment = (base) => {
    const tfhd = new Uint8Array(12);
    tfhd[3] = 8; // default_sample_duration_present
    new DataView(tfhd.buffer).setUint32(4, 1);
    new DataView(tfhd.buffer).setUint32(8, 1000);
    const tfdt = new Uint8Array(8);
    new DataView(tfdt.buffer).setUint32(4, base);
    const trun = new Uint8Array(8);
    new DataView(trun.buffer).setUint32(4, 5);
    return box("moof", box("traf", box("tfhd", tfhd), box("tfdt", tfdt), box("trun", trun)));
  };
  return [init, segment(0), segment(5000)];
}

test("SourceBuffer.abort is harmless while idle and cancels a pending append", () => {
  const context = scope();
  const { buffer } = openBuffer(context);
  expect(() => buffer.abort()).not.toThrow();

  const events = [];
  buffer.addEventListener("abort", () => events.push("abort"));
  buffer.addEventListener("updateend", () => events.push("updateend"));
  buffer.appendBuffer(new Uint8Array([1, 2, 3]));
  buffer.abort();
  context.flush();

  expect(buffer.updating).toBe(false);
  expect(buffer._pipe.size).toBe(0);
  expect(events).toEqual(["abort", "updateend"]);
});

test("removing an old buffered prefix releases append quota", () => {
  const context = scope({ appendQuota: 10 });
  const { source, buffer } = openBuffer(context);
  buffer.appendBuffer(box("mdat", new Uint8Array(2)));
  context.flush();
  source.noteBuffered(10);

  expect(() => buffer.appendBuffer(new Uint8Array(1))).toThrow("SourceBuffer is full");
  buffer.remove(0, 5);
  context.flush();
  expect(buffer.buffered.length).toBe(1);
  expect(buffer.buffered.start(0)).toBe(5);
  expect(buffer.buffered.end(0)).toBe(10);
  expect(() => buffer.appendBuffer(new Uint8Array(5))).not.toThrow();
  context.flush();
  expect(buffer.updating).toBe(false);
});

test("fragmented MP4 buffered end follows appended segments, not presentation duration", () => {
  const context = scope();
  const { source, buffer } = openBuffer(context);
  const [init, first, second] = fragmentedMp4Pieces();
  buffer.appendBuffer(init);
  context.flush();
  // Probing an init segment can expose the full presentation duration before
  // the first media fragment supplies the actual buffered timeline.
  source.noteBuffered(700);
  for (const bytes of [first, second]) {
    buffer.appendBuffer(bytes);
    context.flush();
  }
  expect(buffer.buffered.length).toBe(1);
  expect(buffer.buffered.end(0)).toBe(10);
});

test("WebM buffered end follows Cluster timecodes, not presentation duration", () => {
  const context = scope();
  const source = new context.media.MediaSource();
  source.attach("blob:https://page.test/audio");
  context.flush();
  const buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
  // Cluster timecode 0, one SimpleBlock at +1000 ms, with a dummy payload.
  buffer.appendBuffer(Uint8Array.from([
    0x1f, 0x43, 0xb6, 0x75, 0x8a,
    0xe7, 0x81, 0x00,
    0xa3, 0x85, 0x81, 0x03, 0xe8, 0x00, 0x00,
  ]));
  context.flush();
  source.noteBuffered(700);
  expect(buffer.buffered.end(0)).toBeCloseTo(1.02, 5);
});

test("a media element reports the intersection of separate audio and video buffers", () => {
  const context = scope();
  const { source, buffer: video } = openBuffer(context);
  const audio = source.addSourceBuffer('audio/webm; codecs="opus"');
  video.noteEnd(5);
  audio.noteEnd(8);
  expect(source.bufferedEnd()).toBe(5);
});

test("a media segment appended again is not concatenated twice, while gaps are still filled", () => {
  const context = scope();
  const { buffer } = openBuffer(context);
  const [init, first, second] = fragmentedMp4Pieces();
  let updates = 0;
  buffer.addEventListener("updateend", () => updates++);
  // The second segment arrives first; the first then fills the gap before it.
  for (const bytes of [init, second, first]) {
    buffer.appendBuffer(bytes);
    context.flush();
  }
  const size = buffer._pipe.size;
  expect(size).toBe(init.byteLength + second.byteLength + first.byteLength);
  // A player retrying both segments on a slow network.
  for (const bytes of [first, second]) {
    buffer.appendBuffer(bytes);
    context.flush();
  }
  expect(buffer._pipe.size).toBe(size);
  expect(updates).toBe(5);
  expect(buffer.buffered.end(0)).toBe(10);
});

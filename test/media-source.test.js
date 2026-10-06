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
  buffer.appendBuffer(new Uint8Array(10));
  context.flush();
  source.noteBuffered(10);

  expect(() => buffer.appendBuffer(new Uint8Array(1))).toThrow("SourceBuffer is full");
  buffer.remove(0, 5);
  context.flush();
  expect(() => buffer.appendBuffer(new Uint8Array(5))).not.toThrow();
  context.flush();
  expect(buffer.updating).toBe(false);
});

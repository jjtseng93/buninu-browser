import { expect, test } from "bun:test";
import { PlaybackBuffer } from "../lib/audio/playback-buffer.js";

test("media prepares a bounded reserve regardless of server credits", () => {
  const buffer = new PlaybackBuffer(1000, 2, 0.5);
  expect(buffer.request(0, 0, 0, 0)).toBe(2000);
  expect(buffer.request(0, 2000, 0, 500)).toBe(0);
  expect(buffer.request(1500, 0, 500, 0)).toBe(0);
  expect(buffer.request(1100, 0, 500, 40)).toBe(400);
  expect(buffer.request(1100, 400, 500, 40)).toBe(0);
});

test("startup and starvation recovery require playable PCM, not elapsed time", () => {
  const buffer = new PlaybackBuffer(1000, 2, 0.5);
  expect(buffer.ready(40, 0, false)).toBe(false);
  expect(buffer.ready(398, 0, false)).toBe(false);
  expect(buffer.ready(400, 0, false)).toBe(true);
  expect(buffer.ready(40, 300, false)).toBe(true);
  expect(buffer.ready(0, 0, false)).toBe(false);
  expect(buffer.ready(40, 0, false)).toBe(false);
  expect(buffer.ready(400, 0, false)).toBe(true);
});

test("short clips drain and piano stays interactive", () => {
  const media = new PlaybackBuffer(1000, 2, 0.5);
  expect(media.ready(40, 0, true)).toBe(true);
  const piano = new PlaybackBuffer(1000, 2, 0.12);
  expect(piano.ready(40, 0, false)).toBe(true);
  expect(piano.request(0, 0, 0, 120)).toBe(120);
  expect(piano.request(0, 120, 0, 120)).toBe(0);
});

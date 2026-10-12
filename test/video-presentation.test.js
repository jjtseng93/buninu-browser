import { test, expect } from "bun:test";
import { VideoPresentation, compositeVideo } from "../lib/renderer/video-presentation.js";

test("video predecode is bounded and waits for measured audio, skipping stale frames", async () => {
  let frames = 0, closed = 0;
  const reports = [];
  const engine = { decode: async () => ({ width: 2, height: 2, fps: 30,
    nextFrame: () => { frames++; return new Uint8Array(16).fill(frames); }, close: () => closed++ }) };
  const video = new VideoPresentation(engine, () => {}, r => reports.push(r));
  try {
    await video.open({ id: 1, time: 0, hasAudio: true, audioId: 4, audioStart: 0 });
    await Bun.sleep(100);
    expect(frames).toBeLessThanOrEqual(24);
    expect(video.queue.length).toBeLessThanOrEqual(video.limit);
    expect(video.frame.time).toBe(0);
    const first = reports.length;
    await Bun.sleep(80);
    expect(reports).toHaveLength(first);
    video.timing(4, 0.5);
    await Bun.sleep(60);
    expect(video.frame.time).toBeCloseTo(0.5);
    expect(reports.filter(r => r.time > 0).length).toBe(1);
    video.stop(1);
    video.timing(4, 2);
    await Bun.sleep(30);
    expect(video.frame).toBeNull();
    expect(closed).toBe(1);
  } finally { video.stop(); }
});

test("a late decoder open cannot replace a newer playback generation", async () => {
  let resolve, closed = 0;
  const video = new VideoPresentation({ decode: () => new Promise(r => resolve = r) }, () => {}, () => {});
  const opening = video.open({ id: 1, time: 0 });
  video.stop();
  resolve({ close: () => closed++ });
  await opening;
  expect(closed).toBe(1);
  expect(video.config).toBeNull();
});

test("reopening at a keyframe does not show the prefix before the resume position", async () => {
  let at = 0;
  const reports = [];
  const video = new VideoPresentation({ decode: async () => ({ width: 2, height: 2, fps: 10,
    seek() { at = 0; }, nextFrame(w, h) { at++; return new Uint8Array(w * h * 4).fill(at); }, close() {} }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(9, 2);
    await video.open({ id: 2, time: 2, hasAudio: true, audioId: 9, audioStart: 0 });
    await Bun.sleep(100);
    expect(reports.some(report => report.time >= 1.9)).toBe(true);
    expect(reports.every(report => report.time === undefined || report.time >= 1.9)).toBe(true);
  } finally { video.stop(); }
});

test("video layer preserves opaque controls, translucent overlays and clipped pixels", () => {
  const base = new Uint8Array([0,0,0,255, 255,255,255,255, 0,0,128,255, 10,20,30,255]);
  const mask = new Uint8Array([255,255,255,0, 0,0,0,0, 127,127,127,0, 0,0,0,0]);
  const tile = { pixelWidth: 4, pixelHeight: 1, pixels: base,
    videoLayer: { base, mask, rect: { x: 0, y: 0, width: 4, height: 1 } } };
  const frame = { width: 1, height: 1, pixels: new Uint8Array([200,100,0,255]) };
  expect([...compositeVideo(tile, frame).pixels]).toEqual([
    200,100,0,255, 255,255,255,255, 100,50,128,255, 10,20,30,255,
  ]);
  expect(compositeVideo(tile, null)).toBe(tile);
});

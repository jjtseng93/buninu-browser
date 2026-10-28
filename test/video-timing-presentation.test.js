import { test, expect } from "bun:test";
import { VideoPresentation } from "../lib/renderer/video-presentation.js";

function queuedVideo(changed = () => {}) {
  const reports = [];
  let decoded = 0;
  const video = new VideoPresentation({}, changed, report => reports.push(report));
  Object.assign(video, {
    config: { id: 10, audioId: 7, audioStart: 10, time: 10, hasAudio: true },
    decoder: {
      fps: 10,
      nextFrame() { decoded++; throw new Error("timing must not decode"); },
      close() {},
    },
    queue: [10.1, 10.2, 10.3].map((time, i) => ({
      time, width: 2, height: 2, pixels: new Uint8Array(16).fill(i + 1),
    })),
    nextTime: 10.4,
    frame: null,
    eof: false,
    reportedEnd: false,
  });
  return { video, reports, decoded: () => decoded };
}

test("active measured audio presents due frames before another decode turn", () => {
  let changed = 0;
  const { video, reports, decoded } = queuedVideo(() => changed++);
  const timer = video.timer = setTimeout(() => {}, 100_000);
  try {
    for (const [id, time] of [[8, 0.5], [7, NaN], [7, -1], [7, 0.09]])
      video.timing(id, time);
    expect(video.frame).toBeNull();
    video.timing(7, 0.1);
    expect(video.frame.time).toBe(10.1);
    video.timing(7, 0.1);
    video.timing(7, 0.05);
    expect(changed).toBe(1);
    video.timing(7, 0.3);
    expect(video.frame.time).toBe(10.3);
    expect(changed).toBe(2);
    expect(reports).toEqual([{ id: 10, time: 10.1 }, { id: 10, time: 10.3 }]);
    expect(decoded()).toBe(0);
    expect(video.timer).toBe(timer);

    video.config.audioId = null;
    video.queue.push({ time: 11, width: 2, height: 2, pixels: new Uint8Array(16) });
    video.timing(null, 99);
    expect(changed).toBe(2);
    video.stop();
    video.timing(7, 99);
    expect(changed).toBe(2);
    expect(video.frame).toBeNull();
  } finally { video.stop(); }
});

test("timing and decode turns report EOF once at the measured end boundary", () => {
  const { video, reports, decoded } = queuedVideo();
  try {
    video.eof = true;
    video.timing(7, 0.3);
    expect(reports).toEqual([{ id: 10, time: 10.3 }]);
    video.timing(7, 0.399);
    expect(reports).toHaveLength(1);
    video.timing(7, 0.4);
    video.timing(7, 1);
    video.step();
    expect(reports).toEqual([{ id: 10, time: 10.3 }, { id: 10, end: 10.4 }]);
    expect(decoded()).toBe(0);
  } finally { video.stop(); }
});

test("timing publication copies shared pixels before transferring their buffer", () => {
  const received = [];
  const { video, reports } = queuedVideo(() => {
    expect([...new Uint8Array(video.config.shared, 16, 16)]).toEqual([...video.frame.pixels]);
    received.push(structuredClone(video.frame, { transfer: [video.frame.pixels.buffer] }));
    expect(video.frame.pixels.byteLength).toBe(0);
  });
  video.config.shared = new SharedArrayBuffer(32);
  try {
    video.timing(7, 0.1);
    video.timing(7, 0.2);
    expect(received.map(frame => frame.time)).toEqual([10.1, 10.2]);
    expect(received.map(frame => frame.pixels[0])).toEqual([1, 2]);
    expect(reports).toEqual([{ id: 10, time: 10.1 }, { id: 10, time: 10.2 }]);
    expect([...new Int32Array(video.config.shared, 0, 4)]).toEqual([4, 2, 2, 0]);
  } finally { video.stop(); }
});

test("timing while a decoder opens stores the clock without publishing a stopped generation", async () => {
  let finish, changed = 0, closed = 0;
  const video = new VideoPresentation({ decode: () => new Promise(resolve => { finish = resolve; }) },
    () => changed++, () => {});
  const opening = video.open({ id: 11, audioId: 7, audioStart: 10, time: 10, hasAudio: true });
  try {
    video.timing(7, 2);
    expect(video.clocks.get(7)).toBe(2);
    expect(changed).toBe(0);
    video.stop();
    finish({ close() { closed++; } });
    await opening;
    expect(closed).toBe(1);
    expect(changed).toBe(0);
  } finally { video.stop(); }
});

test("timing publication errors are not mistaken for decoder EOF", () => {
  const { video } = queuedVideo(() => { throw new Error("publish failed"); });
  try {
    expect(() => video.timing(7, 0.1)).toThrow("publish failed");
    expect(video.eof).toBe(false);
    expect(video.reportedEnd).toBe(false);
  } finally { video.stop(); }
});

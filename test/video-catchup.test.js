import { expect, test } from 'bun:test';
import { VideoPresentation } from '../lib/renderer/video-presentation.js';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';

const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4', import.meta.url)).arrayBuffer());
const tick = video => { clearTimeout(video.timer); video.step(); clearTimeout(video.timer); };
function drain(video) {
  for (let n = 0; n < 200 && !video.reportedEnd; n++) tick(video);
  expect(video.reportedEnd).toBe(true);
}
function fixture({ gop = 2, staticPicture = false, probeFailure = false, rewindFailure = false, startTime = 0, frameOffset = 0, endTime, indexed = true } = {}) {
  const calls = [], seeks = [], reports = [], shown = [];
  let at = (startTime - frameOffset) * 10, failRewind = false;
  const decoder = { width: 8, height: 4, fps: 10,
    seek(ms) {
      seeks.push(ms);
      if (failRewind && ms === 1) throw Error('rewind failed');
      at = Math.min(Math.floor(Math.max(0, ms / 1000 - frameOffset) / gop) * gop * 10, Math.floor(5.9 / gop) * gop * 10);
    },
    nextFrame(w, h) {
      calls.push({ w, h, at });
      if (w === 32 && probeFailure) { failRewind = rewindFailure; throw Error('optional probe failed'); }
      if (at >= 60) return null;
      const value = staticPicture ? 1 : at + 1;
      at++;
      return new Uint8Array(w * h * 4).fill(value);
    }, close() {} };
  const video = new VideoPresentation({ decode: async () => { at = (startTime - frameOffset) * 10; return decoder; } }, () => shown.push({ ...video.frame }), r => reports.push(r));
  const config = { id: 1, time: startTime, startTime, bytes: indexed ? bytes : new Uint8Array(), hasAudio: true, audioId: 7, audioStart: startTime, endTime };
  return { video, decoder, config, calls, seeks, reports, shown,
    async open() { video.timing(7, 0); await video.open(config); clearTimeout(video.timer); } };
}

test('overdue playback skips only to a verified later keyframe without changing the audio clock', async () => {
  const f = fixture();
  try {
    await f.open();
    f.video.timing(7, 4.5);
    const first = f.calls.length;
    tick(f.video);
    expect(f.calls.slice(first).filter(c => c.w === 32)).toHaveLength(3);
    expect(f.calls.slice(first).filter(c => c.w === 8).every(c => c.at >= 40)).toBe(true);
    expect(f.video.frame.time).toBeGreaterThanOrEqual(4);
    expect(f.video.frame.time).toBeLessThanOrEqual(4.5 + 1e-6);
    expect(f.video.time()).toBe(4.5);
    expect(f.config.time).toBe(0);
    expect(f.shown.every((frame, i) => i === 0 || frame.time > f.shown[i - 1].time)).toBe(true);
  } finally { f.video.stop(); }
});

test('catch-up retains the real last full-size picture when audio has already passed EOF', async () => {
  await wasmpeg.load();
  const expectedDecoder = await wasmpeg.decode(bytes);
  let finalPixels;
  try { for (let frame; (frame = expectedDecoder.nextFrame());) finalPixels = frame; }
  finally { expectedDecoder.close(); }
  let fullFrames = 0, probes = 0;
  const engine = { async decode() {
    const decoder = await wasmpeg.decode(bytes);
    return { ...decoder, nextFrame(w, h) {
      if (w === 32 && h === 18) probes++;
      else if (w > 1) fullFrames++;
      return decoder.nextFrame(w, h);
    } };
  } };
  const reports = [], video = new VideoPresentation(engine, () => {}, r => reports.push(r));
  try {
    video.timing(8, 0);
    await video.open({ id: 2, time: 0, bytes, hasAudio: true, audioId: 8, audioStart: 0 });
    clearTimeout(video.timer);
    video.timing(8, 100);
    drain(video);
    expect(probes).toBe(3);
    expect(fullFrames).toBeLessThan(40);
    expect(video.frame.time).toBeCloseTo(5.9, 6);
    expect(video.frame.pixels).toEqual(finalPixels);
    expect(reports.filter(r => r.end !== undefined)).toHaveLength(1);
    expect(video.timer).toBeNull();
  } finally { video.stop(); }
});

test('failed or indistinguishable candidates replay the old prefix once and keep the final picture', async () => {
  for (const options of [{ gop: 3 }, { staticPicture: true }, { probeFailure: true }]) {
    const f = fixture(options);
    try {
      await f.open();
      // At 3.9s the index says 2s; the mismatched decoder has GOPs at 0/3s.
      f.video.timing(7, 3.9);
      tick(f.video);
      const probes = f.calls.filter(c => c.w === 32).length;
      expect(probes).toBeGreaterThan(0);
      expect(f.seeks.at(-1)).toBe(1);
      f.video.timing(7, 100);
      drain(f.video);
      expect(f.calls.filter(c => c.w === 32)).toHaveLength(probes);
      expect(f.video.frame.time).toBeCloseTo(5.9, 6);
      expect(f.video.frame.pixels[0]).toBe(options.staticPicture ? 1 : 60);
      expect(f.shown.every((frame, i) => i === 0 || frame.time > f.shown[i - 1].time)).toBe(true);
      expect(f.reports.some(r => r.error)).toBe(false);
      expect(f.reports.filter(r => r.end !== undefined)).toHaveLength(1);
    } finally { f.video.stop(); }
  }
});

test('a failed rewind reports a recoverable worker error rather than inventing EOF', async () => {
  const f = fixture({ probeFailure: true, rewindFailure: true });
  try {
    await f.open();
    f.video.timing(7, 4.5);
    tick(f.video);
    expect(f.reports.some(r => r.error?.includes('rewind failed'))).toBe(true);
    expect(f.reports.some(r => r.end !== undefined)).toBe(false);
    expect(f.video.decoder).toBeNull();
    expect(f.video.timer).toBeNull();
  } finally { f.video.stop(); }
});

test('a later failed candidate replays from the last successful catch-up anchor', async () => {
  const f = fixture();
  try {
    await f.open();
    f.video.limit = 2;
    f.video.timing(7, 2.5); tick(f.video);
    expect(f.video.seekPosition).toEqual({ time: 2, milliseconds: 2000 });
    expect(f.video.frame.time).toBeCloseTo(2.1, 6);
    const nextFrame = f.decoder.nextFrame.bind(f.decoder);
    f.decoder.nextFrame = (w, h) => {
      if (w === 32) throw Error('later fragment cannot be probed');
      return nextFrame(w, h);
    };
    f.video.timing(7, 5); tick(f.video);
    expect(f.seeks.at(-1)).toBe(2000);
    f.video.timing(7, 100); drain(f.video);
    expect(f.video.frame.time).toBeCloseTo(5.9, 6);
    expect(f.video.frame.pixels[0]).toBe(60);
    expect(f.shown.every((frame, i) => i === 0 || frame.time > f.shown[i - 1].time)).toBe(true);
  } finally { f.video.stop(); }
});

test('fractional indexed times keep the exact upward-rounded seek position for rollback', async () => {
  const shifted = bytes.slice(), view = new DataView(shifted.buffer);
  let timescale;
  function visit(start, end) {
    for (let p = start; p + 8 <= end;) {
      const size = view.getUint32(p), type = String.fromCharCode(...shifted.subarray(p + 4, p + 8)), data = p + 8;
      if (size < 8 || p + size > end) throw Error('invalid test fixture');
      if (type === 'mdhd') timescale = view.getUint32(data + (shifted[data] === 1 ? 20 : 12));
      if (type === 'tfdt') {
        if (shifted[data] === 1) view.setBigUint64(data + 4, view.getBigUint64(data + 4) + 1n);
        else view.setUint32(data + 4, view.getUint32(data + 4) + 1);
      }
      if (['moov', 'trak', 'mdia', 'moof', 'traf'].includes(type)) visit(data, p + size);
      p += size;
    }
  }
  visit(0, shifted.length);
  const offset = 1 / timescale, f = fixture({ startTime: offset, frameOffset: offset });
  f.config.bytes = shifted;
  try {
    await f.open();
    f.video.limit = 2;
    f.video.timing(7, 2.5); tick(f.video);
    expect(f.video.seekPosition).toEqual({ time: 2 + offset, milliseconds: 2001 });
    const nextFrame = f.decoder.nextFrame.bind(f.decoder);
    f.decoder.nextFrame = (w, h) => { if (w === 32) throw Error('later probe failed'); return nextFrame(w, h); };
    f.video.timing(7, 5); tick(f.video);
    expect(f.seeks.at(-1)).toBe(2001);
    f.video.timing(7, 100); drain(f.video);
    expect(f.video.frame.time).toBeCloseTo(5.9 + offset, 6);
    expect(f.video.frame.pixels[0]).toBe(60);
  } finally { f.video.stop(); }
});

test('small lag and unindexed sources retain sequential decoding without seek probes', async () => {
  for (const [options, time] of [[{}, 1.5], [{ indexed: false }, 4.5]]) {
    const f = fixture(options);
    try {
      await f.open();
      f.video.timing(7, time);
      tick(f.video);
      expect(f.seeks).toHaveLength(0);
      expect(f.calls.some(c => c.w === 32)).toBe(false);
    } finally { f.video.stop(); }
  }
});

test('an old rollback anchor declines optional probes instead of replaying an unbounded prefix', async () => {
  const f = fixture({ staticPicture: true });
  try {
    await f.open();
    // Play normally for long enough that the original seek is no longer a
    // cheap rollback. Only then does the audio clock suddenly get ahead.
    for (let n = 1; n <= 25; n++) { f.video.timing(7, n / 10); tick(f.video); }
    expect(f.video.nextTime).toBeGreaterThan(3);
    f.video.timing(7, 100); drain(f.video);
    expect(f.seeks).toHaveLength(0);
    expect(f.calls.some(c => c.w === 32 || c.w === 1)).toBe(false);
    expect(f.video.frame.time).toBeCloseTo(5.9, 6);
  } finally { f.video.stop(); }
});

test('queued frames are consumed before an optional seek and config boundaries are never crossed', async () => {
  const f = fixture();
  try {
    await f.open();
    expect(f.video.queue.length).toBeGreaterThan(0);
    f.video.timing(9, 4.5); // A different stream does not consume the queue.
    f.video.bind(1, 9, 0);
    tick(f.video);
    expect(f.seeks).toHaveLength(0);
    f.video.timing(9, 100);
    drain(f.video);
    expect(f.video.frame.pixels[0]).toBe(60);
  } finally { f.video.stop(); }
  for (const endTime of [2, 4, 4.05]) {
    const f = fixture({ endTime });
    try {
      await f.open();
      f.video.timing(7, 100);
      drain(f.video);
      expect(f.shown.every(frame => frame.time + 1e-6 < endTime)).toBe(true);
      expect(f.reports.filter(r => r.end !== undefined).map(r => r.end)).toEqual([endTime]);
    } finally { f.video.stop(); }
  }
});

test('catch-up state resets for a new playback generation', async () => {
  const f = fixture({ staticPicture: true });
  try {
    await f.open();
    f.video.timing(7, 4.5); tick(f.video);
    expect(f.video.catchupDisabled).toBe(true);
    f.video.timing(7, 0);
    await f.video.open({ ...f.config, id: 3 });
    clearTimeout(f.video.timer);
    expect(f.video.catchupDisabled).toBe(false);
    expect(f.video.frame.time).toBe(0);
    f.video.stop();
    expect(f.video.seekPosition).toBeNull();
  } finally { f.video.stop(); }
});

test('rollback retains the absolute start of a later decoder configuration', async () => {
  const f = fixture({ startTime: 2, probeFailure: true });
  try {
    await f.open();
    f.video.timing(7, 3.5); tick(f.video);
    expect(f.seeks.at(-1)).toBe(2000);
    f.video.timing(7, 100); drain(f.video);
    expect(f.video.frame.time).toBeCloseTo(5.9, 6);
    expect(f.video.frame.pixels[0]).toBe(60);
    expect(f.shown.every((frame, i) => frame.time >= 2 && (i === 0 || frame.time > f.shown[i - 1].time))).toBe(true);
  } finally { f.video.stop(); }
});

test('a failed hint does not poison a grown snapshot or duplicate its decoded boundary', async () => {
  // Complete fMP4 fragments ending at 4 seconds; the final fragment grows it
  // to 6 seconds. Use the real index with a decoder whose first snapshot has
  // unsupported probes, and whose replacement supports ordinary keyframe seek.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = 0, fragments = 0;
  for (; end < bytes.length;) {
    const size = view.getUint32(end), type = String.fromCharCode(...bytes.subarray(end + 4, end + 8));
    end += size;
    if (type === 'mdat' && ++fragments === 2) break;
  }
  const prefix = bytes.slice(0, end), shown = [], reports = [];
  const engine = { async decode(source) {
    const old = source.length === prefix.length;
    let at = 0;
    return { width: 8, height: 4, fps: 10,
      seek(ms) { at = Math.min(Math.floor(ms / 2000) * 20, old ? 20 : 40); },
      nextFrame(w, h) {
        if (old && w === 32) throw Error('unsupported optional probe');
        if (at >= (old ? 40 : 60)) return null;
        return new Uint8Array(w * h * 4).fill(++at);
      }, close() {} };
  } };
  const video = new VideoPresentation(engine, () => shown.push({ time: video.frame.time, value: video.frame.pixels[0] }), r => reports.push(r));
  try {
    video.timing(7, 0);
    await video.open({ id: 5, time: 0, bytes: prefix, hasAudio: true, audioId: 7, audioStart: 0, generation: 1, snapshotId: 'growing' });
    clearTimeout(video.timer);
    video.timing(7, 100); drain(video);
    expect(video.catchupDisabled).toBe(true);
    expect(video.nextTime).toBeCloseTo(4, 6);
    expect(await video.extend({ id: 5, revision: 0, generation: 2, snapshotId: 'growing', boundary: 4, bytes })).toBe(true);
    drain(video);
    expect(video.catchupDisabled).toBe(false);
    expect(video.frame.time).toBeCloseTo(5.9, 6);
    expect(video.frame.pixels[0]).toBe(60);
    expect(shown.every((frame, i) => i === 0 || frame.time > shown[i - 1].time)).toBe(true);
    expect(reports.filter(r => r.exhaustedAt !== undefined).map(r => [r.revision, Math.round(r.exhaustedAt)])).toEqual([[0, 4], [1, 6]]);
    expect(reports.some(r => r.error || r.continuationError)).toBe(false);
  } finally { video.stop(); }
});

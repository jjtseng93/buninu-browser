import { expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { seekVideoKeyframe } from '../lib/media/video-keyframe.js';

test('seeking within a GOP longer than ten seconds preserves the decoded frame timestamp', async () => {
  await wasmpeg.load();
  const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/long-video.mp4', import.meta.url)).arrayBuffer());
  const decoder = await wasmpeg.decode(bytes);
  try {
    // This thirty-second fixture has a different picture at every frame,
    // but only its first frame is a keyframe.
    const firstHash = Bun.hash(decoder.nextFrame(32, 18));
    for (const target of [15, 20, 25, 29]) {
      const timestamp = seekVideoKeyframe(decoder, target);
      expect(Bun.hash(decoder.nextFrame(32, 18))).toBe(firstHash);
      expect(timestamp).toBe(0);
    }
  } finally { decoder.close(); }
});

test('a later MP4 initialization keeps absolute seek times, including seeks back across its first GOP', async () => {
  await wasmpeg.load();
  const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4', import.meta.url)).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const visit = (from, to, callback) => {
    for (let offset = from; offset + 8 <= to;) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > to) break;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      callback(type, offset + 8);
      if (['moov', 'trak', 'mdia', 'moof', 'traf'].includes(type)) visit(offset + 8, offset + size, callback);
      offset += size;
    }
  };
  let timescale;
  visit(0, bytes.length, (type, data) => {
    if (type === 'mdhd') timescale = view.getUint32(data + (bytes[data] === 1 ? 20 : 12));
  });
  let fragments = 0;
  visit(0, bytes.length, (type, data) => {
    if (type !== 'tfdt') return;
    fragments++;
    if (bytes[data] === 1) view.setBigUint64(data + 4, view.getBigUint64(data + 4) + BigInt(6 * timescale));
    else view.setUint32(data + 4, view.getUint32(data + 4) + 6 * timescale);
  });
  expect(fragments).toBeGreaterThan(0);
  const decoder = await wasmpeg.decode(bytes, { format: 'mp4' });
  try {
    const hashes = [];
    for (let pixels; (pixels = decoder.nextFrame(32, 18));) hashes.push(Bun.hash(pixels));
    expect(hashes).toHaveLength(60);
    // The fixture's keyframes are 2s apart. After moving tfdt by six seconds,
    // seek(8s) must return frame 20, not frame 0 or an offset-relative frame.
    for (const [target, frame, expectedTime] of [[6, 0, 6], [7.9, 0, 6], [8, 20, 8], [11, 40, 10], [6.2, 0, 6], [5, 0, 6]]) {
      const timestamp = seekVideoKeyframe(decoder, target, 6);
      expect(Bun.hash(decoder.nextFrame(32, 18))).toBe(hashes[frame]);
      expect(timestamp).toBeGreaterThanOrEqual(expectedTime);
      expect(timestamp).toBeLessThan(expectedTime + 1 / decoder.fps);
    }
  } finally { decoder.close(); }
});

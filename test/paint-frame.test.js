import { expect, test } from 'bun:test';
import { cropViewport, encodeImage, encodeImageBase64 } from '../lib/paint/frame.js';
import { FrameCaptureCache } from '../lib/paint/frame-cache.js';
import { appendParagraphText } from '../lib/paint/paragraph-text.js';

function numberedTile() {
  const bytes = new Uint8Array(7 + 3 * 4 * 4);
  const pixels = bytes.subarray(7);
  for (let i = 0; i < 12; i++) pixels.set([i + 1, 20, 30, 255], i * 4);
  return { pixels, pixelWidth: 3, pixelHeight: 4, x: 0, y: 10, width: 3, height: 4, scale: 1,
    background: [99, 0, 0, 128] };
}
const reds = (pixels) => Array.from({ length: pixels.length / 4 }, (_, i) => pixels[i * 4]);

test('full-width viewport crops reuse immutable tile bytes and respect the source byte offset', () => {
  const tile = numberedTile();
  const result = cropViewport(tile, 0, 11, 3, 2);
  expect(result.pixels.buffer).toBe(tile.pixels.buffer);
  expect(reds(result.pixels)).toEqual([4, 5, 6, 7, 8, 9]);
  expect(result.width).toBe(3);
  expect(result.height).toBe(2);
  expect(reds(cropViewport(tile, 0, 10, 3, 4).pixels)).toEqual(reds(tile.pixels));
});

test('partial crops preserve columns, background alpha, and scaled outside rows', () => {
  const tile = numberedTile();
  expect(reds(cropViewport(tile, 1, 11, 2, 2).pixels)).toEqual([5, 6, 8, 9]);
  const clipped = cropViewport(tile, -1, 9, 4, 3);
  expect(reds(clipped.pixels)).toEqual([99, 99, 99, 99, 99, 1, 2, 3, 99, 4, 5, 6]);
  expect([...clipped.pixels.subarray(0, 4)]).toEqual([99, 0, 0, 128]);
  const scaled = { ...tile, scale: 2, width: 1.5, height: 2 };
  expect(reds(cropViewport(scaled, 0.5, 10.5, 1, 1).pixels)).toEqual([5, 6, 8, 9]);
});

test('native base64 capture preserves PNG and JPEG bytes', async () => {
  const tile = numberedTile();
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await encodeImage(tile.pixels, 3, 4, { format, quality: 85 });
    const base64 = await encodeImageBase64(tile.pixels, 3, 4, { format, quality: 85 });
    expect(Buffer.from(base64, 'base64')).toEqual(Buffer.from(bytes));
  }
});

test('encoding releases only its temporary bytes on success and failure', async () => {
  const pixels = new Uint8Array([5, 10, 15, 255]);
  const expected = [...pixels];
  const encoded = await encodeImage(pixels, 1, 1);
  expect(encoded.byteLength).toBeGreaterThan(0);
  expect([...pixels]).toEqual(expected);
  await expect(encodeImage(pixels, 100, 100)).rejects.toThrow();
  expect([...pixels]).toEqual(expected);
  expect((await new Bun.Image(encoded).metadata()).width).toBe(1);
});

test('simultaneous captures share work and an older completion cannot replace the latest frame', async () => {
  const cache = new FrameCaptureCache();
  let completeOld;
  let captures = 0;
  const first = cache.get('old', () => { captures++; return new Promise(resolve => { completeOld = resolve; }); });
  expect(cache.get('old', () => { captures++; })).toBe(first);
  expect(captures).toBe(1);
  const second = cache.get('new', () => 'new frame');
  expect(await second).toBe('new frame');
  completeOld('old frame');
  expect(await first).toBe('old frame');
  expect(cache.get('new', () => { throw new Error('must retain new'); })).toBe(second);
});

test('capture failures allow retry without discarding a newer frame', async () => {
  const cache = new FrameCaptureCache();
  await expect(cache.get('bad', () => { throw new Error('encode failed'); })).rejects.toThrow('encode failed');
  expect(await cache.get('bad', () => 'retry')).toBe('retry');
  let fail;
  const pending = cache.get('old', () => new Promise((_, reject) => { fail = reject; }));
  const next = cache.get('new', () => 'new');
  fail(new Error('old failed'));
  await expect(pending).rejects.toThrow('old failed');
  expect(cache.get('new', () => 'wrong')).toBe(next);
});

function textRuns(text) {
  let emoji = false;
  const runs = [];
  appendParagraphText({
    addText: text => runs.push({ text, emoji }),
    pushStyle: () => { emoji = true; },
    pop: () => { emoji = false; },
  }, text, () => ({}));
  return runs;
}

test('paragraphs batch ordinary text while preserving whole emoji graphemes and fallback boundaries', () => {
  const ordinary = 'Latin office العربية हिन्दी 中文 e\u0301 ';
  expect(textRuns(ordinary)).toEqual([{ text: ordinary, emoji: false }]);
  expect(textRuns('')).toEqual([{ text: ' ', emoji: false }]);
  const emojis = ['👨‍👩‍👧‍👦', '❤️', '🇹🇼', '1️⃣', '👍🏽'];
  const mixed = `${ordinary}${emojis.join(' + ')} end`;
  const runs = textRuns(mixed);
  expect(runs.map(run => run.text).join('')).toBe(mixed);
  expect(runs.filter(run => run.emoji).map(run => run.text)).toEqual(emojis);
  expect(runs[0].text).toBe(ordinary);
  expect(runs.at(-1)).toEqual({ text: ' end', emoji: false });
});

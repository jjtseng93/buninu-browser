import {expect, test} from 'bun:test';
import {captureViewport, rawFrame} from '../lib/paint/frame.js';
import {FrameLeaseTracker} from '../lib/paint/shared-frame-pool.js';
import {captureVideoViewport, compositeVideo} from '../lib/renderer/video-presentation.js';

function fixture(width = 19, height = 31, sourceOffset = 0, shared = false) {
  const base = new Uint8Array(shared ? new SharedArrayBuffer(width * height * 4) : new ArrayBuffer(width * height * 4));
  const mask = new Uint8Array(base.length);
  for (let i = 0; i < width * height; i++) {
    const at = i * 4, kind = i < width * 4 ? 0 : i % 4;
    base.set(kind === 2 ? [20, 30, 40, 200] : [0, 0, 0, kind === 1 ? 93 : 255], at);
    if (kind !== 3) mask.set(kind === 2 ? [127, 80, 190, 0] : [255, 255, 255, 0], at);
  }
  const pixels = new Uint8Array(new ArrayBuffer(5 * 7 * 4 + sourceOffset), sourceOffset);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i * 71 % 256;
  return {
    tile: {x:3.2, y:8.7, width:width/1.25, height:height/1.25, scale:1.25,
      pixelWidth:width, pixelHeight:height, pixels:base, background:[12, 34, 56, 128],
      videoLayer:{base, mask, rect:{x:-1.25, y:0.6, width:22.5, height:30.2}}},
    frame: {width:5, height:7, pixels},
  };
}

function compare(tile, frame, viewport, clip, format) {
  const whole = compositeVideo(tile, frame, format);
  const expected = captureViewport(whole, ...viewport, clip);
  const actual = captureVideoViewport(tile, frame, ...viewport, clip, format);
  expect(actual).not.toBeNull();
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
  expect(actual.pixels).toEqual(expected.pixels);
  expect(actual.pixels.buffer).not.toBe(tile.pixels.buffer);
  expect(actual.pixels.buffer).not.toBe(tile.videoLayer.base.buffer);
  expect(actual.pixels.buffer.byteLength).toBe(actual.width * actual.height * 4);
  expect(actual.pixelFormat).toBe(format);
  whole.pixels.buffer.transfer(0);
  actual.pixels.buffer.transfer(0);
}

test('viewport-first video preserves fractional clip phase, clipped masks, alpha and outside background', () => {
  for (const offset of [0, 1]) {
    const {tile, frame} = fixture(19, 31, offset);
    const original = new Uint8Array(tile.pixels), mask = new Uint8Array(tile.videoLayer.mask);
    for (const format of ['rgba', 'bgra']) {
      // Full-width zero-copy base crop, then partial and completely outside
      // crops. A fractional viewport without clip keeps its floor semantics.
      for (const viewport of [[3.2, 13.1, 15.2, 6.3], [4.13, 17.91, 7.3, 9.8], [-5, -4, 12, 15], [90, 90, 8, 5]]) {
        compare(tile, frame, viewport, undefined, format);
        compare(tile, frame, viewport, {x:viewport[0], y:viewport[1], width:viewport[2], height:viewport[3], scale:1}, format);
      }
      frame.pixels[0] ^= 255;
      compare(tile, frame, [3.2, 13.1, 15.2, 6.3], undefined, format);
    }
    expect(tile.pixels).toEqual(original);
    expect(tile.videoLayer.mask).toEqual(mask);
  }
});

test('original tile coordinates remain exact over changing DPR, crop and decoded dimensions', () => {
  let seed = 0x831d24;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let sample = 0; sample < 150; sample++) {
    const {tile, frame} = fixture(1 + Math.floor(random() * 29), 1 + Math.floor(random() * 37), sample % 2);
    tile.scale = [0.75, 1, 1.25, 1.5, 2.25][sample % 5];
    tile.width = tile.pixelWidth / tile.scale;
    tile.height = tile.pixelHeight / tile.scale;
    tile.videoLayer.rect = {x:random() * 12 - 6, y:random() * 12 - 6,
      width:0.2 + random() * 34, height:0.2 + random() * 43};
    const viewport = [random() * 24 - 8, random() * 35 - 8, 0.2 + random() * 26, 0.2 + random() * 22];
    const clip = sample % 3 ? {x:viewport[0], y:viewport[1], width:viewport[2], height:viewport[3], scale:1} : undefined;
    compare(tile, frame, viewport, clip, sample % 2 ? 'bgra' : 'rgba');
    // Reusing this layer with another crop/decoded size must rebuild only the
    // geometry plan, never retain pixels from an earlier decoded frame.
    frame.width = 7; frame.height = 5;
    frame.pixels[0] ^= 127;
    viewport[1] += 0.49 / tile.scale;
    compare(tile, frame, viewport, clip && {...clip, y:viewport[1]}, sample % 2 ? 'rgba' : 'bgra');
  }
});

test('unsupported scaled clips keep the original path and invalid unit-scale clips still reject', () => {
  const {tile, frame} = fixture();
  for (const scale of [0, 0.5, 2, NaN]) expect(captureVideoViewport(tile, frame, 0, 0, 5, 5,
    {x:0, y:0, width:5, height:5, scale})).toBeNull();
  expect(captureVideoViewport(tile, null, 0, 0, 5, 5)).toBeNull();
  expect(captureVideoViewport({...tile, videoLayer:null}, frame, 0, 0, 5, 5)).toBeNull();
  for (const clip of [{x:NaN, y:0, width:5, height:5, scale:1}, {x:0, y:0, width:0, height:5, scale:1},
    {x:0, y:0, width:9000, height:5, scale:1}]) expect(() => captureVideoViewport(tile, frame, 0, 0, 5, 5, clip)).toThrow();
});

test('raw cropped captures own their buffers independently of recyclable frame leases', async () => {
  const {tile, frame} = fixture(20, 40, 0, true);
  const released = [], leases = new FrameLeaseTracker(serial => released.push(serial));
  leases.replace(1, tile);
  const result = await leases.capture(retained => {
    const capture = captureVideoViewport(retained, frame, tile.x, tile.y + 4, 16, 8, undefined, 'bgra');
    return rawFrame(capture.pixels, capture.width, capture.height, 'bgra', {takeOwnership:true, inputFormat:capture.pixelFormat});
  });
  const expected = new Uint8Array(result.pixels);
  leases.replace(2, {...tile});
  expect(released).toEqual([1]);
  tile.videoLayer.base.fill(42);
  expect(result.pixels).toEqual(expected);
  result.pixels.buffer.transfer(0);
  expect(tile.pixels.byteLength).toBe(20 * 40 * 4);
  expect(frame.pixels.byteLength).toBe(5 * 7 * 4);
});

test('opaque-run skipping initializes dirty allocations, including unaligned sources and preserved alpha', () => {
  const allocate = Bun.allocUnsafe;
  let allocations = 0;
  Bun.allocUnsafe = size => { allocations++; return new Uint8Array(size).fill(0xa5); };
  try {
    for (const offset of [0, 1]) for (const rectHeight of [4, 30.2]) {
      const {tile, frame} = fixture(20, 40, offset);
      tile.videoLayer.rect.height = rectHeight;
      const base = new Uint8Array(tile.videoLayer.base);
      // A full-width crop borrows the base. Alternate channel order and crop
      // origins to invalidate cached source views, while reusing the layer.
      for (const format of ['rgba', 'bgra', 'rgba']) for (const y of [tile.y, tile.y + 4, tile.y]) {
        compare(tile, frame, [tile.x, y, 16, 8], undefined, format);
        frame.pixels[0] ^= 127;
      }
      expect(tile.videoLayer.base).toEqual(base);
    }
    expect(allocations).toBe(36);
  } finally { Bun.allocUnsafe = allocate; }
});

test('an entirely opaque capture writes every channel while a capture without opaque runs copies every byte', () => {
  const allocate = Bun.allocUnsafe;
  Bun.allocUnsafe = size => new Uint8Array(size).fill(0xa5);
  try {
    for (const offset of [0, 1]) for (const opaque of [false, true]) {
      const {tile, frame} = fixture(20, 40, offset);
      tile.videoLayer.rect = {x:0, y:0, width:20, height:40};
      tile.videoLayer.base.fill(0);
      for (let i=3;i<tile.videoLayer.base.length;i+=4) tile.videoLayer.base[i] = 255;
      tile.videoLayer.mask.fill(opaque ? 255 : 0);
      for (const format of ['rgba', 'bgra']) compare(tile, frame, [tile.x, tile.y, 16, 8], undefined, format);
    }
  } finally { Bun.allocUnsafe = allocate; }
});

test('unexpected pooled allocations fall back to independently owned aligned capture bytes', () => {
  const allocate = Bun.allocUnsafe, borrowed = [];
  Bun.allocUnsafe = size => {
    const pixels = new Uint8Array(size + 8).subarray(4, size + 4);
    borrowed.push(pixels);
    return pixels;
  };
  try {
    const {tile, frame} = fixture(20, 40);
    for (const format of ['rgba', 'bgra']) compare(tile, frame, [tile.x, tile.y, 16, 8], undefined, format);
    expect(borrowed).toHaveLength(2);
    // compare() detached the returned captures; the unexpected pool is intact.
    expect(borrowed.every(pixels => pixels.byteLength === 20 * 10 * 4)).toBe(true);
  } finally { Bun.allocUnsafe = allocate; }
});

test('partial-width and out-of-tile crops preserve the initialized crop fallback', () => {
  const allocate = Bun.allocUnsafe;
  Bun.allocUnsafe = () => { throw Error('noncontiguous crops already own their initialized pixels'); };
  try {
    const {tile, frame} = fixture(20, 40, 1);
    for (const format of ['rgba', 'bgra']) {
      compare(tile, frame, [tile.x + 1, tile.y, 12, 8], undefined, format);
      compare(tile, frame, [tile.x - 4, tile.y - 3, 16, 8], undefined, format);
    }
  } finally { Bun.allocUnsafe = allocate; }
});

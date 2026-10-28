import { expect, test } from 'bun:test';
import { floatToS16 } from '../lib/audio/pcm.js';

// The previous implementation is a byte-order-explicit reference, independent
// of native Int16Array storage. Check full output bytes, not native readings.
function reference(samples) {
  const out = new Uint8Array(samples.length * 2), view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return out;
}

// Exercise the actual DataView fallback on little-endian test machines. Only
// replace the host-endian probe; the function under test stays the source file.
const source = await Bun.file(new URL('../lib/audio/pcm.js', import.meta.url)).text();
const probe = 'const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;';
if (!source.includes(probe)) throw new Error('Update the endian-fallback test probe');
const fallbackModule = await import('data:text/javascript;base64,' + Buffer.from(
  source.replace(probe, 'const LITTLE_ENDIAN = false;'),
).toString('base64'));

for (const [name, convert] of [['native', floatToS16], ['explicit little-endian fallback', fallbackModule.floatToS16]]) {
  test(`s16le ${name}: zero, clamp, NaN, infinities, subnormals and signed rounding`, () => {
    const values = [0, -0, NaN, Infinity, -Infinity, 1, -1, 2, -2,
      Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE,
      0.5, -0.5, 0.5 / 32767, -0.5 / 32768, 1.5 / 32767, -1.5 / 32768,
      32766.5 / 32767, -32767.5 / 32768];
    expect(convert(values)).toEqual(reference(values));
    expect(convert(new Float32Array(values))).toEqual(reference(new Float32Array(values)));
    expect([...convert(new Float32Array([1, -1, 0.5, -0.5]))]).toEqual([255,127,0,128,0,64,0,192]);
    expect(convert(new Float32Array())).toEqual(new Uint8Array());
  });

  test(`s16le ${name}: every signed integer midpoint and adjacent inputs match previous rounding`, () => {
    const values = [];
    for (let value = -32768; value < 32767; value++) {
      const midpoint = (value + 0.5) / (value < 0 ? 32768 : 32767);
      values.push(midpoint - Number.EPSILON, midpoint, midpoint + Number.EPSILON);
    }
    expect(convert(values)).toEqual(reference(values));
    const decoded = new Float32Array(values);
    expect(convert(decoded)).toEqual(reference(decoded));
  });

  test(`s16le ${name}: randomized Float32 bit patterns preserve exact bytes and ownership`, () => {
    const storage = new ArrayBuffer(4 * 100002), words = new Uint32Array(storage);
    let state = 0xa538f219;
    for (let i = 0; i < words.length; i++) words[i] = state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    words.set([0x80000000, 0x7f800000, 0xff800000, 0x7fc00001, 0xffc00001, 1, 0x80000001], 1);
    const input = new Float32Array(storage, 4, 100000), before = new Uint8Array(storage).slice();
    const first = convert(input), second = convert(input);
    expect(first).toEqual(reference(input));
    expect(first).toEqual(second);
    expect(first.buffer).not.toBe(input.buffer);
    expect(first.buffer).not.toBe(second.buffer);
    expect(first.byteOffset).toBe(0);
    first.buffer.transfer(0);
    expect(second.byteLength).toBe(input.length * 2);
    expect(new Uint8Array(storage)).toEqual(before);
  });
}

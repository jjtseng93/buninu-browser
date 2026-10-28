// Typed-array stores use host byte order; the wire format is always s16le.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Interleaved Float32 samples in [-1, 1] (as audio decoders produce) as s16le bytes. */
export function floatToS16(samples) {
  const out = new Uint8Array(samples.length * 2);
  if (LITTLE_ENDIAN) {
    const view = new Int16Array(out.buffer);
    for (let index = 0; index < samples.length; index++) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      view[index] = Math.round(value < 0 ? value * 32768 : value * 32767);
    }
    return out;
  }
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return out;
}

/** Consume at most `bytes` of interleaved s16le output, leaving whole frames. */
export function splitSamples(samples, channels, bytes) {
  const count = Math.min(samples.length, Math.floor(bytes / (channels * 2)) * channels);
  return [samples.subarray(0, count), samples.subarray(count)];
}

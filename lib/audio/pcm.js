/** Interleaved Float32 samples in [-1, 1] (as audio decoders produce) as s16le bytes. */
export function floatToS16(samples) {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return out;
}

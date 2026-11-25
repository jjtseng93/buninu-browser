// Partitioned overlap-add convolution. Short partitions deliver the beginning
// of the response immediately. Longer partitions start far enough into the
// response to collect their input without delaying the output stream.
const plans = new Map();
function fftPlan(size) {
  let plan = plans.get(size);
  if (plan) return plan;
  const reverse = new Uint16Array(size);
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 1; i < size; i++) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * size / 2);
  for (let k = 0; k < size / 2; k++) {
    cos[k] = Math.cos(2 * Math.PI * k / size);
    sin[k] = Math.sin(2 * Math.PI * k / size);
  }
  plan = (real, imag, inverse) => {
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j <= i) continue;
      const r = real[i], b = imag[i];
      real[i] = real[j]; imag[i] = imag[j]; real[j] = r; imag[j] = b;
    }
    for (let half = 1; half < size; half *= 2) {
      const step = size / (2 * half);
      for (let start = 0; start < size; start += 2 * half) {
        for (let k = 0; k < half; k++) {
          const a = start + k, b = a + half, c = cos[k * step], s = inverse ? sin[k * step] : -sin[k * step];
          const r = c * real[b] - s * imag[b], j = s * real[b] + c * imag[b];
          real[b] = real[a] - r; imag[b] = imag[a] - j;
          real[a] += r; imag[a] += j;
        }
      }
    }
    if (inverse) for (let i = 0; i < size; i++) real[i] /= size;
  };
  plans.set(size, plan);
  return plan;
}

export function createConvolution(response, rate, normalize, quantum) {
  const length = response[0].length;
  let scale = 1;
  if (normalize) {
    let power = 0;
    for (const channel of response) for (const x of channel) power += x * x;
    const rms = Math.sqrt(power / (length * response.length));
    scale = 10 ** (-58 / 20) * 44100 / rate / Math.max(0.000125, rms || 0.000125);
    if (response.length === 4) scale *= 0.5;
  }
  const tiers = [];
  for (let offset = 0; offset < length;) {
    const block = Math.min(4096, Math.max(quantum, offset));
    let tier = tiers.at(-1);
    if (tier?.block !== block) {
      const vector = () => new Float32Array(2 * block);
      tier = {offset, block, fft: fftPlan(2 * block), kernels: [], history: [], cursor: 0, filled: 0, used: 0,
        realWork: vector(), imagWork: vector()};
      tiers.push(tier);
    }
    const channels = response.map(channel => {
      const real = new Float32Array(2 * block), imag = new Float32Array(2 * block);
      for (let i = 0; i < Math.min(block, length - offset); i++) real[i] = channel[offset + i] * scale;
      tier.fft(real, imag, false);
      return {real, imag};
    });
    tier.kernels.push(channels);
    tier.history.push(Array.from({length: 2}, () => ({
      real: new Float32Array(2 * block), imag: new Float32Array(2 * block)
    })));
    offset += block;
  }
  const ringSize = 2 ** Math.ceil(Math.log2(tiers.at(-1).offset + 2 * tiers.at(-1).block + quantum));
  const ring = [new Float32Array(ringSize), new Float32Array(ringSize)];
  let position = 0, stereoTail = 0;
  return input => {
    const stereo = input.length === 2 * quantum;
    if (stereo) stereoTail = length + quantum;
    for (const tier of tiers) {
      const {block, used, fft, history, cursor, kernels, realWork, imagWork} = tier;
      const current = history[cursor];
      current[0].real.set(input.subarray(0, quantum), used);
      current[1].real.set(stereo ? input.subarray(quantum) : input.subarray(0, quantum), used);
      tier.used += quantum;
      if (tier.used !== block) continue;
      tier.used = 0;
      for (const {real, imag} of current) {
        real.fill(0, block); imag.fill(0);
        fft(real, imag, false);
      }
      // An older kernel contributes to this same output block using an
      // equally old input spectrum. Sum these products before inverting.
      tier.filled = Math.min(tier.filled + 1, kernels.length);
      const start = position + quantum - block + tier.offset;
      for (let dest = 0; dest < 2; dest++) {
        realWork.fill(0); imagWork.fill(0);
        for (let j = 0; j < tier.filled; j++) {
          const previous = history[(cursor - j + history.length) % history.length];
          for (let source = 0; source < 2; source++) {
            if (source !== dest && response.length !== 4) continue;
            const channel = response.length === 4 ? 2 * source + dest : dest % response.length;
            const ir = kernels[j][channel], {real, imag} = previous[source];
            for (let k = 0; k < 2 * block; k++) {
              realWork[k] += real[k] * ir.real[k] - imag[k] * ir.imag[k];
              imagWork[k] += real[k] * ir.imag[k] + imag[k] * ir.real[k];
            }
          }
        }
        fft(realWork, imagWork, true);
        for (let i = 0; i < 2 * block - 1; i++) ring[dest][(start + i) & (ringSize - 1)] += realWork[i];
      }
      tier.cursor = (cursor + 1) % history.length;
    }
    const output = new Float32Array(quantum * (response.length > 1 || stereoTail > 0 ? 2 : 1));
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < quantum; i++) {
        const at = (position + i) & (ringSize - 1);
        if (c === 0 || output.length > quantum) output[c * quantum + i] = ring[c][at];
        ring[c][at] = 0;
      }
    }
    position = (position + quantum) & (ringSize - 1);
    stereoTail = Math.max(0, stereoTail - quantum);
    return output;
  };
}

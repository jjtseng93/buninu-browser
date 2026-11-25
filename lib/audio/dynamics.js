// Stereo-linked gain reduction with lookahead. Positive knee widths round
// the transition from unity gain to the selected compression ratio.
export function compressQuantum(input, state, settings, rate, frames) {
  const channels = input.length / frames, delay = state.delay[0].length;
  const output = new Float32Array(input.length);
  const { threshold, knee, ratio, attack, release } = settings;
  const attackStep = attack > 0 ? -Math.expm1(-1 / (rate * attack)) : 1;
  const releaseStep = release > 0 ? -Math.expm1(-1 / (rate * release)) : 1;
  const slope = 1 / ratio - 1;
  for (let i = 0; i < frames; i++) {
    const l = input[i], r = channels === 1 ? l : input[frames + i];
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const above = peak ? 20 * Math.log10(peak) - threshold : -Infinity;
    let db = 0;
    if (above >= knee / 2) db = slope * above;
    else if (above > -knee / 2) db = slope * (above + knee / 2) ** 2 / (2 * knee);
    state.reduction += (db - state.reduction) * (db < state.reduction ? attackStep : releaseStep);
    const gain = 10 ** (state.reduction / 20), at = state.cursor;
    output[i] = state.delay[0][at] * gain;
    if (channels === 2) output[frames + i] = state.delay[1][at] * gain;
    state.delay[0][at] = l; state.delay[1][at] = r;
    state.cursor = (at + 1) % delay;
  }
  return output;
}

export function stereoPanQuantum(input, pan, frames) {
  const output = new Float32Array(2 * frames);
  for (let i = 0; i < frames; i++) {
    const p = Math.max(-1, Math.min(1, pan[i])), l = input[i];
    if (input.length === frames) {
      const theta = (p + 1) * Math.PI / 4;
      output[i] = l * Math.cos(theta); output[i + frames] = l * Math.sin(theta);
    } else {
      const r = input[i + frames], theta = (p <= 0 ? p + 1 : p) * Math.PI / 2;
      output[i] = p <= 0 ? l + r * Math.cos(theta) : l * Math.cos(theta);
      output[i + frames] = p <= 0 ? r * Math.sin(theta) : r + l * Math.sin(theta);
    }
  }
  return output;
}

import { floatToS16 } from "./pcm.js";

// The compact, home-row layout used by the standalone audio preview.
// MIDI 60 is middle C (do); the next keys follow the white keys.
export const PIANO_KEYS = Object.freeze({ " ": 60, j: 62, k: 64, l: 65, ";": 67, "'": 69, Enter: 71 });

export function pianoNote(key) {
  return PIANO_KEYS[key.length === 1 ? key.toLowerCase() : key] ?? null;
}

/** A short struck-string-like tone, mono 48 kHz s16le PCM. */
export function pianoTone(note, rate = 48000) {
  const frames = Math.round(rate * 0.55);
  const samples = new Float32Array(frames);
  const frequency = 440 * 2 ** ((note - 69) / 12);
  for (let index = 0; index < frames; index++) {
    const time = index / rate;
    const attack = Math.min(1, time * 160);
    const release = Math.min(1, (frames - index) / (rate * 0.035));
    const fundamental = Math.sin(2 * Math.PI * frequency * time);
    const harmonics = 0.32 * Math.sin(4 * Math.PI * frequency * time)
      + 0.13 * Math.sin(6 * Math.PI * frequency * time);
    samples[index] = 0.28 * attack * release * Math.exp(-4.8 * time) * (fundamental + harmonics);
  }
  return floatToS16(samples);
}

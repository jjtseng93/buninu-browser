import { floatToS16 } from "./pcm.js";

// lazyC/sdcard/piano/index.html's sound-producing keyboard rows. The table
// is relative to Space = MIDI 60 (C4). Change PIANO_DO alone to transpose
// every key; the default A4 exactly matches lazyC's original octave.
// The lazyC key intervals remain fixed in the table.
// Browser control keys (Escape, Tab, CapsLock, Shift, Alt, Control, Backspace)
// are intentionally omitted. Space and Enter remain playable as requested.
export const PIANO_KEYS = Object.freeze({
  F1: 29, F2: 36, F3: 41, F4: 45, F5: 48, F6: 53,
  F7: 81, F8: 83, F9: 84, F10: 86, F11: 88, F12: 89,
  "`": 33, "1": 36, "2": 43, "3": 48, "4": 52, "5": 55, "6": 49,
  "7": 74, "8": 76, "9": 77, "0": 79, "-": 81, "=": 83,
  q: 31, w: 38, e: 43, r: 47, t: 50, y: 79, u: 69,
  i: 71, o: 72, p: 74, "[": 76, "]": 77, "\\": 79,
  a: 33, s: 40, d: 45, f: 48, g: 52, h: 72, j: 62,
  k: 64, l: 65, ";": 67, "'": 69, Enter: 71,
  z: 28, x: 35, c: 40, v: 43, b: 47, n: 67, m: 57,
  ",": 59, ".": 60, "/": 62, " ": 60,
});
export const PIANO_DO = 69; // A4, lazyC's original Space pitch.

const CODE_KEYS = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  Space: " ", NumpadEnter: "Enter",
};
const SHIFTED_KEYS = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
  "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[",
  "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

/** Prefer physical code when present; IME text falls back to event.key/data. */
export function pianoNote(key, code = "") {
  const physical = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
      : CODE_KEYS[code] ?? (code.startsWith("F") ? code : null);
  const typed = key.length === 1 ? (SHIFTED_KEYS[key] ?? key.toLowerCase())
    : key === "Space" || key === "Spacebar" ? " " : key;
  const note = PIANO_KEYS[physical ?? typed];
  return note === undefined ? null : note + PIANO_DO - 60;
}

/** A short struck-string tone, mono 48 kHz s16le PCM. */
export function pianoTone(note, rate = 48000) {
  const frames = Math.round(rate * 0.7);
  const samples = new Float32Array(frames);
  const frequency = 440 * 2 ** ((note - 69) / 12);
  // The original left-hand register is quiet on small speakers. Raise only
  // its level; leave pitch and relative harmonic balance untouched.
  const gain = 1 + Math.max(0, Math.min(1, (60 - note) / 24));
  // Piano strings are slightly stiff and two strings of a note beat softly.
  // These are partials of the requested pitch, not a transposition.
  const partials = [1, 0.32, 0.13, 0.055, 0.025];
  const phases = partials.map((_, index) => {
    const harmonic = index + 1;
    const stretched = harmonic * Math.sqrt(1 + 0.00015 * harmonic * harmonic);
    return 2 * Math.PI * frequency * stretched;
  });
  for (let index = 0; index < frames; index++) {
    const time = index / rate;
    const attack = Math.min(1, time * 320);
    const release = Math.min(1, (frames - index) / (rate * 0.035));
    let sound = 0;
    for (let partial = 0; partial < partials.length; partial++) {
      const decay = Math.exp(-(3.5 + partial * 1.2) * time);
      const phase = phases[partial] * time;
      sound += partials[partial] * decay * (
        0.82 * Math.sin(phase) + 0.18 * Math.sin(phase * 1.0017)
      );
    }
    samples[index] = 0.28 * gain * attack * release * sound;
  }
  return floatToS16(samples);
}

/** Mixes all piano notes into one persistent mono PCM stream. */
export class PianoMixer {
  #cache = new Map();
  #voices = [];

  trigger(note) {
    let tone = this.#cache.get(note);
    if (!tone) {
      const bytes = pianoTone(note);
      tone = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      this.#cache.set(note, tone);
    }
    this.#voices.push({ tone, position: 0 });
    if (this.#voices.length > 16) this.#voices.shift();
  }

  render(bytes) {
    const frames = Math.max(0, Math.floor(bytes / 2));
    const output = new Uint8Array(frames * 2);
    const view = new DataView(output.buffer);
    for (let frame = 0; frame < frames; frame++) {
      let mixed = 0;
      for (const voice of this.#voices) {
        if (voice.position < voice.tone.length) mixed += voice.tone[voice.position++];
      }
      // Soft limiting avoids crackles when several struck notes overlap.
      view.setInt16(frame * 2, Math.round(32767 * Math.tanh(mixed / 32768)), true);
    }
    this.#voices = this.#voices.filter((voice) => voice.position < voice.tone.length);
    return output;
  }
}

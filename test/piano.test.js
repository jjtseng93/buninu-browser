import { test, expect } from "bun:test";
import { PIANO_KEYS, pianoNote, pianoTone } from "../lib/audio/piano.js";

test("piano keyboard mapping is editable in one table", () => {
  expect(PIANO_KEYS[" "]).toBe(60);
  expect(pianoNote("j")).toBe(62);
  expect(pianoNote("K")).toBe(64);
  expect(pianoNote("l")).toBe(65);
  expect(pianoNote("z")).toBeNull();
});

test("piano tone is 48 kHz mono PCM with a nonzero, decaying sound", () => {
  const tone = pianoTone(60);
  expect(tone.byteLength).toBe(Math.round(48000 * 0.55) * 2);
  const view = new DataView(tone.buffer);
  const peak = (start, end) => {
    let value = 0;
    for (let i = start; i < end; i++) value = Math.max(value, Math.abs(view.getInt16(i * 2, true)));
    return value;
  };
  expect(peak(1000, 2000)).toBeGreaterThan(1000);
  expect(peak(20000, 21000)).toBeLessThan(peak(1000, 2000));
});

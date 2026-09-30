import { test, expect } from "bun:test";
import { PIANO_KEYS, PIANO_DO, pianoNote, pianoTone } from "../lib/audio/piano.js";

test("piano keyboard mapping is editable in one table", () => {
  expect(Object.keys(PIANO_KEYS)).toHaveLength(61);
  expect(PIANO_DO).toBe(69);
  expect(PIANO_KEYS[" "]).toBe(60);
  expect(pianoNote(" ")).toBe(69);
  expect(pianoNote("j")).toBe(71);
  expect(pianoNote("K")).toBe(73);
  expect(pianoNote("l")).toBe(74);
  expect(pianoNote("F1")).toBe(38);
  expect(pianoNote("F12")).toBe(98);
  expect(pianoNote("z")).toBe(37);
  expect(pianoNote("q")).toBe(40);
  expect(pianoNote("/", "Slash")).toBe(71);
  expect(pianoNote("Unidentified", "KeyJ")).toBe(71);
  expect(pianoNote("!", "Digit1")).toBe(45);
  expect(pianoNote("Escape")).toBeNull();
});

test("piano tone is 48 kHz mono PCM with a nonzero, decaying sound", () => {
  const tone = pianoTone(60);
  expect(tone.byteLength).toBe(Math.round(48000 * 0.7) * 2);
  const view = new DataView(tone.buffer);
  const peak = (start, end) => {
    let value = 0;
    for (let i = start; i < end; i++) value = Math.max(value, Math.abs(view.getInt16(i * 2, true)));
    return value;
  };
  expect(peak(1000, 2000)).toBeGreaterThan(1000);
  expect(peak(20000, 21000)).toBeLessThan(peak(1000, 2000));
  expect(peak(0, tone.byteLength / 2)).toBeLessThan(32767);
  const low = pianoTone(37);
  const lowView = new DataView(low.buffer);
  let lowPeak = 0;
  for (let i = 1000; i < 2000; i++) lowPeak = Math.max(lowPeak, Math.abs(lowView.getInt16(i * 2, true)));
  expect(lowPeak).toBeGreaterThan(peak(1000, 2000));
});

import { test, expect } from "bun:test";
import { PIANO_KEYS, PIANO_DO, pianoNote, pianoTone, PianoMixer } from "../lib/audio/piano.js";

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

test("piano mixer keeps notes continuous across requests and limits chords", () => {
  const one = new PianoMixer();
  one.trigger(69);
  const first = one.render(4096);
  const second = one.render(4096);
  const reference = pianoTone(69);
  expect(first.byteLength).toBe(4096);
  expect(second.byteLength).toBe(4096);
  const combined = new Uint8Array(8192);
  combined.set(first);
  combined.set(second, 4096);
  expect(combined.some((value) => value !== 0)).toBe(true);
  const uninterrupted = new PianoMixer();
  uninterrupted.trigger(69);
  expect(combined).toEqual(uninterrupted.render(8192));
  expect(reference.byteLength).toBeGreaterThan(combined.byteLength);
  const chord = new PianoMixer();
  for (const note of [69, 73, 76, 81]) chord.trigger(note);
  const pcm = chord.render(8192);
  const view = new DataView(pcm.buffer);
  let peak = 0;
  for (let i = 0; i < pcm.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  expect(peak).toBeGreaterThan(1000);
  expect(peak).toBeLessThan(32767);
});

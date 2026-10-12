import { test, expect } from "bun:test";
import { handlePianoInput } from "../lib/renderer/piano-input.js";

const input = { getAttribute: () => "buninu-piano-input" };

test("CDP raw keydown uses the physical key even with an empty text field", () => {
  const notes = [];
  const play = n => notes.push(n);
  for (let i = 0; i < 3; i++) {
    expect(handlePianoInput(input, { key: " ", code: "Space", text: "", modifiers: 0, repeat: false }, play)).toBe(true);
  }
  expect(notes).toEqual([69, 69, 69]);
  expect(handlePianoInput(input, { key: "F1", code: "F1", text: "" }, play)).toBe(true);
  expect(notes.at(-1)).toBe(38);
  expect(handlePianoInput(input, { key: " ", code: "Space", text: " ", repeat: true }, play)).toBe(true);
  expect(notes).toHaveLength(4);
  expect(handlePianoInput(input, { key: "Tab", code: "Tab", text: "" }, play)).toBe(false);
});

test("piano consumes batched terminal/IME text and plays every mapped note", () => {
  const notes = [];
  expect(handlePianoInput(input, { text: "jk L!中" }, n => notes.push(n))).toBe(true);
  expect(notes).toEqual([71, 73, 69, 74, 45]);
  expect(handlePianoInput(input, { text: "jk" }, null)).toBe(true);
});

test("piano consumes repeats without retriggering and supports shifted physical keys", () => {
  const notes = [];
  const play = n => notes.push(n);
  expect(handlePianoInput(input, { key: "j", repeat: true }, play)).toBe(true);
  expect(handlePianoInput(input, { key: " ", repeat: true }, play)).toBe(true);
  expect(handlePianoInput(input, { key: "J", code: "KeyJ", modifiers: 8 }, play)).toBe(true);
  expect(handlePianoInput(input, { key: "j", modifiers: 2 }, play)).toBe(true);
  expect(notes).toEqual([71]);
  expect(handlePianoInput(input, { key: "Tab" }, play)).toBe(false);
  expect(handlePianoInput(input, { key: "Backspace" }, play)).toBe(false);
});

test("ordinary, disabled and readonly editors are unaffected", () => {
  expect(handlePianoInput({ getAttribute: () => "editor" }, { text: "jk" })).toBe(false);
  expect(handlePianoInput({ ...input, disabled: true }, { text: "jk" })).toBe(false);
  expect(handlePianoInput({ ...input, readOnly: true }, { text: "jk" })).toBe(false);
  expect(handlePianoInput(null, { text: "jk" })).toBe(false);
});

import { pianoNote } from "../audio/piano.js";

// Keep a real editable input so mobile keyboards can open, but consume piano
// input before text editing. Terminals and IMEs may commit several keys at once.
export function handlePianoInput(element, input, play) {
  if (element?.getAttribute?.("id") !== "buninu-piano-input" || element.disabled || element.readOnly) return false;
  // CDP key events also carry text (often "" on rawKeyDown). Only a text-only
  // commit belongs here; otherwise use key/code, including Space and F1–F12.
  if (input.key === undefined && input.text !== undefined) {
    for (const key of String(input.text)) {
      const note = pianoNote(key);
      if (note !== null) play?.(note);
    }
    return true;
  }
  const note = pianoNote(String(input.key), String(input.code ?? ""));
  if (note === null) return false;
  // Suppressing text insertion must not depend on whether a note is retriggered
  // or an audio backend is available. Shift still selects a physical piano key.
  if (!input.repeat && !(Number(input.modifiers) & 7)) play?.(note);
  return true;
}

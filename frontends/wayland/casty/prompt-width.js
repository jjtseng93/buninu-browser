// Terminal display widths for the address bar, copied from jsmdcui's command
// prompt (MIT, Copyright (c) 2016-2020 Zachary Yedidia, et al.; Copyright (c)
// 2026 Dr. John). Indices are UTF-16 code units, as in jsmdcui.

function isWideCodePoint(cp) {
  if (cp < 0x1100) return false;
  return (
    cp <= 0x115F ||
    cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3040 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0xA4C6) ||
    (cp >= 0xA960 && cp <= 0xA97C) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE19) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1B000 && cp <= 0x1B0FF) ||
    (cp >= 0x1F004 && cp <= 0x1F0CF) ||
    (cp >= 0x1F18F && cp <= 0x1F19A) ||
    (cp >= 0x1F200 && cp <= 0x1F2FF) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF) ||
    (cp >= 0x20000 && cp <= 0x2FFFD) ||
    (cp >= 0x30000 && cp <= 0x3FFFD)
  );
}

function isZeroWidthCodePoint(cp) {
  return (
    cp === 0x200D ||
    (cp >= 0x0300 && cp <= 0x036F) ||
    (cp >= 0x1AB0 && cp <= 0x1AFF) ||
    (cp >= 0x1DC0 && cp <= 0x1DFF) ||
    (cp >= 0x20D0 && cp <= 0x20FF) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) ||
    (cp >= 0xFE20 && cp <= 0xFE2F) ||
    (cp >= 0xE0100 && cp <= 0xE01EF)
  );
}

function isEmojiVariationBase(cp) {
  return (
    cp === 0x00A9 || cp === 0x00AE ||
    cp === 0x203C || cp === 0x2049 ||
    cp === 0x2122 || cp === 0x2139 ||
    (cp >= 0x2194 && cp <= 0x21AA) ||
    (cp >= 0x231A && cp <= 0x231B) ||
    cp === 0x2328 || cp === 0x23CF ||
    (cp >= 0x23E9 && cp <= 0x23F3) ||
    (cp >= 0x23F8 && cp <= 0x23FA) ||
    cp === 0x24C2 ||
    (cp >= 0x25AA && cp <= 0x25AB) ||
    cp === 0x25B6 || cp === 0x25C0 ||
    (cp >= 0x25FB && cp <= 0x25FE) ||
    (cp >= 0x2600 && cp <= 0x27BF) ||
    (cp >= 0x2934 && cp <= 0x2935) ||
    (cp >= 0x2B05 && cp <= 0x2B55) ||
    cp === 0x3030 || cp === 0x303D ||
    cp === 0x3297 || cp === 0x3299
  );
}

const TAB_WIDTH = 4;

export function charWidth(ch) {
  if (!ch) return 0;
  const cp = ch.codePointAt(0);
  if (cp === 9) return TAB_WIDTH;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || isZeroWidthCodePoint(cp)) return 0;
  if (isWideCodePoint(cp)) return 2;
  return 1;
}

function displayUnitAt(text, idx) {
  const cp = text.codePointAt(idx);
  if (cp == null) return { text: '', width: 0, length: 0 };
  let length = cp > 0xFFFF ? 2 : 1;
  let unit = String.fromCodePoint(cp);
  let width = charWidth(unit);
  const nextCp = text.codePointAt(idx + length);
  if (nextCp === 0xFE0F && isEmojiVariationBase(cp)) {
    unit += String.fromCodePoint(nextCp);
    length += 1;
    width = 2;
  }
  return { text: unit, width, length };
}

export function displayWidth(text) {
  let width = 0;
  for (let i = 0; i < text.length;) {
    const unit = displayUnitAt(text, i);
    if (unit.length <= 0) break;
    width += unit.width;
    i += unit.length;
  }
  return width;
}

// Convert a screen-column offset (visualCol) into a string char-unit index,
// starting from startIdx (code-unit index) in line and walking forward.
// Snaps to the start of a wide character when the click lands on its right cell.
export function visualColToCharIdx(line, startIdx, visualCol) {
  let col = 0;
  let i = startIdx;
  while (i < line.length) {
    if (col >= visualCol) break;
    const cp = line.codePointAt(i);
    const charLen = cp > 0xFFFF ? 2 : 1;
    const w = charWidth(String.fromCodePoint(cp));
    if (col + w > visualCol) break;
    col += w;
    i += charLen;
  }
  return Math.min(i, line.length);
}

/**
 * jsmdcui's prompt line: the label and value scroll horizontally so the
 * cursor stays on screen. Returns the new scroll offset, the code-unit index
 * the visible part starts at, and the cursor's screen column (0-based).
 */
export function promptView(label, value, cursor, cols, scrollX = 0) {
  const total = label + value;
  const cursorInTotal = displayWidth(label) + displayWidth(value.slice(0, cursor));
  if (cursorInTotal > scrollX + cols - 1) scrollX = cursorInTotal - (cols - 1);
  if (cursorInTotal < scrollX) scrollX = cursorInTotal;
  scrollX = Math.max(0, scrollX);
  let start = scrollX > 0 ? visualColToCharIdx(total, 0, scrollX) : 0;
  // A wide character cut by the left edge is not drawn: its visible half
  // becomes a blank column (lead), so the text and cursor columns agree.
  let lead = 0;
  const startWidth = displayWidth(total.slice(0, start));
  if (startWidth < scrollX) {
    const cp = total.codePointAt(start);
    start += cp > 0xFFFF ? 2 : 1;
    lead = startWidth + charWidth(String.fromCodePoint(cp)) - scrollX;
  }
  return { scrollX, start, lead, cursorCol: cursorInTotal - scrollX };
}

/** The leading part of `text` that fits in `cols` columns. */
export function fitWidth(text, cols) {
  return text.slice(0, visualColToCharIdx(text, 0, cols));
}

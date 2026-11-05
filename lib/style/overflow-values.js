import {parseCSSComponentValues} from './css-value-tokens.js';

const properties = new Set(['overflow', 'overflow-x', 'overflow-y', 'overflow-block', 'overflow-inline']);
const keywords = new Set(['visible', 'hidden', 'clip', 'scroll', 'auto', 'overlay']);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const scrollable = value => value !== 'visible' && value !== 'clip';

/** undefined: unrelated; null: invalid; otherwise a specified value. */
export function normalizeOverflow(name, input, allowPending = true) {
  if (!properties.has(name.toLowerCase())) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  const tokens = parsed.tokens;
  if (!tokens.length || tokens.length > (name.toLowerCase() === 'overflow' ? 2 : 1)
    || tokens.some(token => token.kind !== 'ident')) return null;
  const values = tokens.map(token => token.value.toLowerCase());
  if (values.length === 1 && wide.has(values[0])) return values[0];
  if (values.some(value => !keywords.has(value))) return null;
  return values.length === 2 && values[0] === values[1] ? values[0] : values.join(' ');
}

export function overflowWide(value) { return wide.has(value); }

// Keep the CSS computed value separate from the renderer's clip/scroll flags.
// CSS Overflow 3 (2026-08-13), section 3.1: visible becomes auto next to a
// scrollable axis; clip remains non-scrollable, allowing single-axis scrolling.
export function resolveOverflow(style) {
  let x = style.overflowValueX, y = style.overflowValueY;
  if (x === 'overlay') x = 'auto';
  if (y === 'overlay') y = 'auto';
  if (x === 'visible' && scrollable(y)) x = 'auto';
  if (y === 'visible' && scrollable(x)) y = 'auto';
  style.overflowValueX = x;
  style.overflowValueY = y;
  style.overflowX = x === 'visible' ? 'visible' : 'clip';
  style.overflowY = y === 'visible' ? 'visible' : 'clip';
  style.overflowScrollX = x === 'scroll' || x === 'auto' ? 'auto' : x === 'hidden' ? 'hidden' : null;
  style.overflowScrollY = y === 'scroll' || y === 'auto' ? 'auto' : y === 'hidden' ? 'hidden' : null;
}

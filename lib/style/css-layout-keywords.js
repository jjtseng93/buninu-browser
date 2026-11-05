import {parseCSSComponentValues} from './css-value-tokens.js';

// Only properties whose behavior is already consumed by layout belong here.
const grammars = new Map([
  ['box-sizing', new Set(['content-box', 'border-box'])],
  ['position', new Set(['static', 'relative', 'absolute', 'sticky', 'fixed'])],
  ['flex-direction', new Set(['row', 'row-reverse', 'column', 'column-reverse'])],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);

/** undefined: unrelated; null: invalid; string: normalized or pending. */
export function normalizeLayoutKeyword(name, input, allowPending = true) {
  const grammar = grammars.get(name.toLowerCase());
  if (!grammar) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length !== 1 || parsed.tokens[0].kind !== 'ident') return null;
  const value = parsed.tokens[0].value.toLowerCase();
  return grammar.has(value) || wide.has(value) ? value : null;
}

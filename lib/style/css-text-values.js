import {parseCSSComponentValues} from './css-value-tokens.js';

const grammars = new Map([
  ['overflow-wrap', new Set(['normal', 'break-word', 'anywhere'])],
  ['word-break', new Set(['normal', 'break-all', 'keep-all', 'break-word', 'manual', 'auto-phrase'])],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const decorationStyles = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);

// word-wrap is a legacy alias, including its CSSOM slot, priority and removal.
export function textWrappingProperty(name) {
  if (typeof name !== 'string') return name;
  const lower = name.toLowerCase();
  return lower === 'word-wrap' ? 'overflow-wrap' : grammars.has(lower) ? lower : name;
}

/** undefined: unrelated property; null: invalid; string: canonical/pending. */
export function normalizeTextWrapping(name, input, allowPending = true) {
  const grammar = grammars.get(textWrappingProperty(name));
  if (!grammar) return undefined;
  return normalizeKeyword(grammar, input, allowPending);
}

export function normalizeTextDecorationStyle(name, input, allowPending = true) {
  if (name.toLowerCase() !== 'text-decoration-style') return undefined;
  return normalizeKeyword(decorationStyles, input, allowPending);
}

function normalizeKeyword(grammar, input, allowPending) {
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length !== 1 || parsed.tokens[0].kind !== 'ident') return null;
  const value = parsed.tokens[0].value.toLowerCase();
  return grammar.has(value) || wide.has(value) ? value : null;
}

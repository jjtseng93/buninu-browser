import {parseCSSComponentValues} from './css-value-tokens.js';
import {animationNumericToken, animationNumericComputed} from './animation-numeric-values.js';

const properties = new Set(['flex-grow', 'flex-shrink']);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
// Both flex factors and animation iteration counts use nonnegative numbers.
// Reuse their typed math evaluator, but not the animation-only "infinite" keyword.
const numericGrammar = 'animation-iteration-count';

/** undefined: unrelated; null: invalid; string: normalized or pending. */
export function normalizeFlexFactor(name, input, allowPending = true) {
  if (!properties.has(name)) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length !== 1) return null;
  const token = parsed.tokens[0];
  if (token.kind === 'ident') return wide.has(token.value.toLowerCase()) ? token.value.toLowerCase() : null;
  const normalized = animationNumericToken(numericGrammar, token);
  if (normalized === null) return null;
  // Only accept calculations this number-only layout path can resolve. A
  // context-dependent calculation must not be advertised and then ignored.
  return Number.isFinite(computedFlexFactor(normalized)) ? normalized : null;
}

export function computedFlexFactor(value) {
  return Number(animationNumericComputed(numericGrammar, value, parseCSSComponentValues));
}

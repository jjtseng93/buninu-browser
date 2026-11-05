import {parseCSSComponentValues} from './css-value-tokens.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';

const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const maximum = 3.4028234663852886e38;
const format = value => String(Object.is(value, -0) ? 0 : value);
const finiteLiteral = value => Math.max(-maximum, Math.min(maximum, value));

function alpha(token) {
  if (!['number', 'dimension', 'function'].includes(token.kind)) return null;
  const result = absoluteCSSNumericValue(token);
  if (!result) return null;
  const type = Object.entries(result.type).filter(([, exponent]) => exponent);
  if (!type.length) return {...result, percentage: false};
  return type.length === 1 && type[0][0] === 'percent' && type[0][1] === 1
    ? {...result, percentage: true} : null;
}

function mathText(value, percentage) {
  if (Number.isFinite(value)) return `${format(value)}${percentage ? '%' : ''}`;
  const constant = Number.isNaN(value) ? 'NaN' : value < 0 ? '-infinity' : 'infinity';
  return `${constant}${percentage ? ' * 1%' : ''}`;
}

/** undefined: unrelated; null: invalid; string: normalized or pending. */
export function normalizeOpacity(name, input, allowPending = true) {
  if (name.toLowerCase() !== 'opacity') return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length !== 1) return null;
  const token = parsed.tokens[0];
  if (token.kind === 'ident') return wide.has(token.value.toLowerCase()) ? token.value.toLowerCase() : null;
  const result = alpha(token);
  if (!result) return null;
  // Specified literals retain their out-of-range value. Percentages serialize
  // as numbers, while math retains its numeric/percentage calculation type.
  if (token.kind === 'function') return `calc(${mathText(result.value, result.percentage)})`;
  return format(finiteLiteral(result.value) / (result.percentage ? 100 : 1));
}

export function computedOpacity(value) {
  const tokens = parseCSSComponentValues(value)?.tokens;
  const result = tokens?.length === 1 ? alpha(tokens[0]) : null;
  if (!result) return undefined;
  const alphaValue = result.value / (result.percentage ? 100 : 1);
  // CSS Values: top-level NaN becomes zero before the property's range clamp.
  return Number.isNaN(alphaValue) ? 0 : Math.min(1, Math.max(0, alphaValue));
}

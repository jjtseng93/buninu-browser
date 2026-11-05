import {parseCSSComponentValues, trimCSSWhitespace} from './css-value-tokens.js';
import {typedCSSNumericValue} from './animation-numeric-values.js';
import {serializeDeferredCSSMath} from './css-math-serialization.js';
import {serializeComputedColor} from './cssom-color.js';

const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const maximum = 3.4028234663852886e38;
const finite = value => Math.max(-maximum, Math.min(maximum, Number.isNaN(value) ? 0 : value));
const format = value => String(Object.is(value, -0) ? 0 : value);
const isLength = result => result?.type.length === 1
  && Object.entries(result.type).every(([type, exponent]) => !exponent || type === 'length' && exponent === 1);

function length(token) {
  if (token.kind === 'number') return Number(token.value) === 0 ? '0px' : null;
  if (!['dimension', 'function'].includes(token.kind) || !isLength(typedCSSNumericValue(token))) return null;
  return token.kind === 'function' ? serializeDeferredCSSMath(token)
    : `${format(finite(Number(token.value)))}${token.unit.toLowerCase()}`;
}

function color(token) {
  const value = token.kind === 'ident' ? token.value.toLowerCase()
    : token.kind === 'hash' ? `#${token.value}` : token.kind === 'function' ? token.source : null;
  if (value === 'currentcolor') return value;
  const rgba = value && Bun.color(value, 'rgba');
  if (!/^rgba?\(/.test(rgba ?? '')) return null;
  return token.kind === 'ident' ? value : serializeComputedColor(rgba);
}

// CSS Backgrounds 3: [<color>? && <length>{2,4} && inset?]#.
// The length group must be contiguous; color/inset cannot interrupt it.
function layers(tokens) {
  const groups = [[]];
  for (const token of tokens) token.kind === ',' ? groups.push([]) : groups.at(-1).push(token);
  const result = [];
  for (const group of groups) {
    const lengths = [];
    let shade = null, inset = false, ended = false;
    for (const token of group) {
      const value = length(token);
      if (value !== null) {
        if (ended || lengths.length === 4 || lengths.length === 2 && token.kind !== 'function' && Number(token.value) < 0) return null;
        lengths.push(value);
      } else {
        if (lengths.length) ended = true;
        if (token.kind === 'ident' && token.value.toLowerCase() === 'inset') {
          if (inset) return null;
          inset = true;
        } else {
          const value = color(token);
          if (shade !== null || value === null) return null;
          shade = value;
        }
      }
    }
    if (lengths.length < 2) return null;
    result.push({lengths, color: shade, inset});
  }
  return result;
}

/** undefined: unrelated; null: invalid; string: canonical or pending. */
export function normalizeBoxShadow(name, input, allowPending = true) {
  if (name.toLowerCase() !== 'box-shadow') return undefined;
  const text = trimCSSWhitespace(String(input)), parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length === 1 && parsed.tokens[0].kind === 'ident') {
    const value = parsed.tokens[0].value.toLowerCase();
    return value === 'none' || wide.has(value) ? value : null;
  }
  const shadows = layers(parsed.tokens);
  return shadows?.map(shadow => [shadow.color, ...shadow.lengths, shadow.inset ? 'inset' : null].filter(Boolean).join(' ')).join(', ') ?? null;
}

/** Resolve the very same grammar for software paint and computed CSSOM. */
export function computedBoxShadows(value, resolveLength) {
  if (value === 'none') return null;
  const parsed = parseCSSComponentValues(value);
  const shadows = parsed && !parsed.pending && layers(parsed.tokens);
  if (!shadows) return undefined;
  const result = [];
  for (const shadow of shadows) {
    const values = shadow.lengths.map(text => {
      const result = typedCSSNumericValue(parseCSSComponentValues(text).tokens[0], resolveLength);
      return isLength(result) ? finite(result.value) : undefined;
    });
    if (values.includes(undefined)) return undefined;
    const [x, y, blur = 0, spread = 0] = values;
    const currentColor = shadow.color === null || shadow.color === 'currentcolor';
    result.push(Object.freeze({x, y, blur: Math.max(0, blur), spread, inset: shadow.inset,
      color: currentColor ? null : Bun.color(shadow.color, 'rgba'),
      ...(currentColor ? {currentColor: true} : {})}));
  }
  return Object.freeze(result);
}

export function serializeBoxShadows(shadows, serializeLength) {
  return shadows?.map(shadow => [serializeComputedColor(shadow.color),
    ...[shadow.x, shadow.y, shadow.blur, shadow.spread].map(serializeLength),
    shadow.inset ? 'inset' : null].filter(Boolean).join(' ')).join(', ') || 'none';
}

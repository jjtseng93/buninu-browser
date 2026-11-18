import {blendModes} from './blend-modes.js';
import {parseColorFilter} from './color-filter.js';
import {normalizeCounter} from './counter-values.js';
import {parseCSSComponentValues} from './css-value-tokens.js';

// Only properties whose behavior is already consumed by layout belong here.
const containment = ['size', 'inline-size', 'layout', 'style', 'paint'];
const grammars = new Map([
  ['appearance', new Set(['auto', 'none', 'button', 'checkbox', 'listbox', 'menulist', 'menulist-button', 'meter', 'progress-bar', 'push-button', 'radio', 'searchfield', 'slider-horizontal', 'square-button', 'textarea', 'textfield'])],
  ['contain', new Set(['none', 'strict', 'content', ...containment])],
  ['box-sizing', new Set(['content-box', 'border-box'])],
  ['content-visibility', new Set(['visible', 'hidden', 'auto'])],
  ['background-blend-mode', new Set(['normal', ...[...blendModes.keys()].filter(mode => mode !== 'plus-lighter')])],
  ['mix-blend-mode', new Set(['normal', ...blendModes.keys()])],
  ['isolation', new Set(['auto', 'isolate'])],
  ['position', new Set(['static', 'relative', 'absolute', 'sticky', 'fixed'])],
  ['flex-direction', new Set(['row', 'row-reverse', 'column', 'column-reverse'])],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);

/** undefined: unrelated; null: invalid; string: normalized or pending. */
export function normalizeLayoutKeyword(name, input, allowPending = true) {
  if (name === 'filter' || name === 'backdrop-filter') return parseColorFilter(String(input), false, allowPending);
  if (name === 'counter-reset' || name === 'counter-increment' || name === 'counter-set')
    return normalizeCounter(name, String(input), allowPending);
  const grammar = grammars.get(name.toLowerCase());
  if (!grammar) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (name === 'background-blend-mode' && parsed.tokens.length > 1) {
    const modes = [];
    for (const [index, token] of parsed.tokens.entries()) {
      if (index % 2) {
        if (token.kind !== ',') return null;
      } else {
        if (token.kind !== 'ident' || !grammar.has(token.value.toLowerCase())) return null;
        modes.push(token.value.toLowerCase());
      }
    }
    return parsed.tokens.length % 2 ? modes.join(', ') : null;
  }
  if (name.toLowerCase() === 'contain' && parsed.tokens.length > 1) {
    const values = new Set(parsed.tokens.map(token=>token.kind === 'ident' && token.value.toLowerCase()));
    if (values.size !== parsed.tokens.length || values.has('size') && values.has('inline-size')) return null;
    const ordered = containment.filter(keyword=>values.has(keyword));
    return ordered.length === values.size ? ordered.join(' ') : null;
  }
  if (parsed.tokens.length !== 1 || parsed.tokens[0].kind !== 'ident') return null;
  const value = parsed.tokens[0].value.toLowerCase();
  return grammar.has(value) || wide.has(value) ? value : null;
}

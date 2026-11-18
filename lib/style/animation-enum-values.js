import CSSPropertyList from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/CSSPropertyList.ts';
import {normalizeAnimationShorthand} from './animation-values.js';
import {parseCSSComponentValues as components} from './css-value-tokens.js';
import {animationNumericToken, animationNumericInitial, animationNumericComputed} from './animation-numeric-values.js';
import {easingToken,computedEasing} from './easing-values.js';
// Validation is shared by CSSOM, feature queries and the rendering cascade.
// Animation longhands accept comma-separated typed values, not arbitrary CSS text.
const grammars = new Map([
  ['transition-behavior', ['normal', 'allow-discrete']],
  ['animation-direction', ['normal', 'reverse', 'alternate', 'alternate-reverse']],
  ['animation-fill-mode', ['none', 'forwards', 'backwards', 'both']],
  ['animation-play-state', ['running', 'paused']],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
/** undefined: not handled; null: invalid; string: normalized or pending substitution. */
export function normalizeAnimationEnum(name, input, allowPending = true) {
  if (name === 'animation') return normalizeAnimationShorthand(input, allowPending);
  const propertyList = name === 'transition-property';
  const grammar = grammars.get(name);
  const timing=name==='animation-timing-function' || name==='transition-timing-function';
  if (name !== 'animation-name' && !propertyList && !grammar && !timing && animationNumericInitial(name) === undefined) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = components(text);
  if (!parsed) return null;
  // Substitution is validated again at computed-value time. Other tokens in
  // an unresolved value may become valid only after var()/env() replacement.
  if (parsed.pending) return allowPending ? text : null;
  const tokens = parsed.tokens;
  if (tokens.length === 1 && tokens[0].kind === 'ident' && wide.has(tokens[0].value.toLowerCase()))
    return tokens[0].value.toLowerCase();
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2) { if (token.kind !== ',') return null; continue; }
    if (name === 'animation-name') {
      if (token.kind === 'string') values.push(token.source);
      else if (token.kind === 'ident' && !wide.has(token.value.toLowerCase()) && token.value.toLowerCase() !== 'default')
        values.push(token.value.toLowerCase() === 'none' ? 'none' : token.source);
      else return null;
      continue;
    }
    if (propertyList) {
      if (token.kind !== 'ident') return null;
      const word = token.value.toLowerCase();
      if (wide.has(word) || word === 'default' || word === 'none' && tokens.length !== 1) return null;
      const known = word === 'all' || word === 'none' || Object.hasOwn(CSSPropertyList.kebabCase, word);
      values.push(known ? word : token.source);
      continue;
    }
    const value = timing ? easingToken(token) : grammar ? token.kind === 'ident' && grammar.includes(token.value.toLowerCase()) ? token.value.toLowerCase() : null : animationNumericToken(name, token);
    if (value === null) return null;
    values.push(value);
  }
  return tokens.length % 2 ? values.join(', ') : null;
}

/** Resolved longhand value, including a shorthand's value and the initial default. */
export function animationEnumValue(style, name) {
  if (name.startsWith('transition-')) return undefined;
  const grammar = grammars.get(name);
  const timing=name==='animation-timing-function';
  if (name === 'animation-name') return (style.cssAnimationLonghands?.name ?? style.cssAnimations?.map(item => item.name) ?? ['none']).join(', ');
  if (!grammar && !timing && animationNumericInitial(name) === undefined) return undefined;
  const key = name.slice(10).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return (style.cssAnimationLonghands?.[key] ?? style.cssAnimations?.map(item => item[key]) ?? [timing?'ease':grammar?.[0] ?? animationNumericInitial(name)]).map(value => timing?computedEasing(value,style):animationNumericComputed(name, value, components)).join(', ');
}


export function computedAnimationNumericValue(name, value, style, resolveRelative) {
  if(name==='animation-timing-function'||name==='transition-timing-function')return computedEasing(value,style);
  return animationNumericComputed(name, value, components, resolveRelative);
}

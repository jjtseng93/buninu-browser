import {parseCSSComponentValues} from './css-value-tokens.js';
import {animationLists} from './animation-values.js';
import {normalizeAnimationEnum} from './animation-enum-values.js';
import {animationNumericToken} from './animation-numeric-values.js';
import {easingToken} from './easing-values.js';

const defaults = {property:'all', duration:'0s', 'timing-function':'ease', delay:'0s', behavior:'normal'};
const wide = new Set(['initial','inherit','unset','revert','revert-layer']);
export function expandTransition(value, allowPending = true) {
  const parsed = parseCSSComponentValues(value);
  if (!parsed?.tokens.length) return null;
  const fields = Object.keys(defaults);
  if (parsed.pending) return allowPending ? fields.map(field => ({name:'transition-'+field,value,pendingBorder:'transition'})) : null;
  if (parsed.tokens.length === 1 && wide.has(parsed.tokens[0].value?.toLowerCase()))
    return fields.map(field => ({name:'transition-'+field,value:parsed.tokens[0].value.toLowerCase()}));
  const items = [];
  let item = {};
  for (const token of parsed.tokens) {
    if (token.kind === ',') {
      if (!Object.keys(item).length) return null;
      items.push(item); item = {}; continue;
    }
    const time = item.duration === undefined ? 'duration' : 'delay';
    const duration = animationNumericToken('transition-'+time, token);
    const easing = easingToken(token);
    const word = token.kind === 'ident' && token.value.toLowerCase();
    if (duration != null && item[time] === undefined) item[time] = duration;
    else if (item.delay === undefined && animationNumericToken('transition-delay', token) != null)
      item.delay = animationNumericToken('transition-delay', token);
    else if (easing != null && item['timing-function'] === undefined) item['timing-function'] = easing;
    else if ((word === 'normal' || word === 'allow-discrete') && !item.behavior) item.behavior = word;
    else if (word && !wide.has(word) && !item.property) {
      item.property = normalizeAnimationEnum('transition-property',token.source,false);
      if (!item.property) return null;
    } else return null;
  }
  if (!Object.keys(item).length) return null;
  items.push(item);
  if (items.length > 1 && items.some(item => item.property === 'none')) return null;
  return fields.map(field => ({name:'transition-'+field,value:items.map(item => item[field] ?? defaults[field]).join(', ')}));
}

export function computedTransition(style) {
  const [properties,durations,easings,delays,behaviors] = ['transitionProperty','transitionDuration',
    'transitionTimingFunction','transitionDelay','transitionBehavior'].map(field => animationLists(style[field]));
  return properties.map((property,i) => [property !== 'all' && property,
    (durations[i % durations.length] !== '0s' || delays[i % delays.length] !== '0s') && durations[i % durations.length], easings[i % easings.length] !== 'ease' && easings[i % easings.length],
    delays[i % delays.length] !== '0s' && delays[i % delays.length], behaviors[i % behaviors.length] !== 'normal' && behaviors[i % behaviors.length]].filter(Boolean).join(' ') || 'all').join(', ');
}

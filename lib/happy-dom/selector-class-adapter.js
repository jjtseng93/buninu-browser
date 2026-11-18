import SelectorItem from '../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts';

// Selectors need only membership, not DOMTokenList's public Proxy/indexed API.
// Keep one entry per live element, validated against the attribute on every
// match; Attr/NamedNodeMap writes and detached mutations need no observer.
const classes = new WeakMap();
const whitespace = /[\t\f\n\r ]+/;
const empty = {tokens: Object.freeze([]), membership: null};

// Rule indexing and final selector matching must use the same token boundaries.
export function selectorClassEntry(element) {
  const source = element.getAttribute?.('class');
  if (!source) {
    classes.delete(element);
    return empty;
  }
  const cached = classes.get(element);
  if (cached?.source === source) return cached;
  const trimmed = source.trim();
  const tokens = trimmed ? trimmed.split(whitespace) : [];
  const membership = tokens.length > 16 ? new Set(tokens) : null;
  const entry = {source, tokens: membership ? [...membership] : tokens, membership};
  classes.set(element, entry);
  return entry;
}

SelectorItem.prototype.matchClass = function(element) {
  const names = this.classNames;
  if (!names) return null;
  if (!names.length) return {priorityWeight:0};
  const {tokens, membership} = selectorClassEntry(element);
  for (const name of names) {
    if (!(membership ? membership.has(name) : tokens.includes(name))) return null;
  }
  return {priorityWeight:names.length * 10};
};

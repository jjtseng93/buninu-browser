import SelectorItem from '../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts';

// Selectors need only membership, not DOMTokenList's public Proxy/indexed API.
// Keep one entry per live element, validated against the attribute on every
// match; Attr/NamedNodeMap writes and detached mutations need no observer.
const classes = new WeakMap();
const whitespace = /[\t\f\n\r ]+/;
SelectorItem.prototype.matchClass = function(element) {
  const names = this.classNames;
  if (!names) return null;
  if (!names.length) return {priorityWeight:0};
  const source = element.getAttribute('class') ?? '';
  if (!source) { classes.delete(element); return null; }
  let cached = classes.get(element);
  if (!cached || cached.source !== source) {
    // Match the vendored DOMTokenList's trim/split behavior exactly. Repeated
    // attribute tokens do not affect membership or selector specificity.
    const trimmed = source.trim();
    cached = {source, tokens:trimmed ? trimmed.split(whitespace) : []};
    classes.set(element, cached);
  }
  for (const name of names) if (!cached.tokens.includes(name)) return null;
  return {priorityWeight:names.length * 10};
};

import ValidityState from '../../vendor/happy-dom/packages/happy-dom/src/validity-state/ValidityState.ts';

const patternTypes = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const patterns = new WeakMap();
const descriptor = Object.getOwnPropertyDescriptor(ValidityState.prototype, 'patternMismatch');

// HTML's compiled pattern algorithm validates the unwrapped source first,
// then anchors it. Keep invalid expressions cached too; validity is queried
// repeatedly during typing, and a bad pattern must not throw into page code.
// https://html.spec.whatwg.org/multipage/input.html#attr-input-pattern
function compiledPattern(element, source) {
  let cached = patterns.get(element);
  if (!cached || cached.source !== source) {
    let expression = null;
    try {
      new RegExp(source, 'v');
      expression = new RegExp(`^(?:${source})$`, 'v');
    } catch {}
    cached = { source, expression };
    patterns.set(element, cached);
  }
  return cached.expression;
}

Object.defineProperty(ValidityState.prototype, 'patternMismatch', {
  ...descriptor,
  get() {
    const element = this.element;
    if (element.localName !== 'input' || !patternTypes.has(element.type)) return false;
    const source = element.getAttribute('pattern');
    const value = element.value;
    if (source === null || value === '') return false;
    const expression = compiledPattern(element, source);
    if (!expression) return false;
    const values = element.type === 'email' && element.multiple
      ? value.split(',').map(part => part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))
      : [value];
    return values.some(part => !expression.test(part));
  },
});

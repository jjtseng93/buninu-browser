// Editing state is document-local and inheritance follows the DOM tree, not
// the composed tree: a shadow host does not make its shadow contents editable.
const designModes = new WeakMap();
const asciiLower = value => String(value).replace(/[A-Z]/g, c => c.toLowerCase());
export function designMode(document) { return designModes.get(document) ?? 'off'; }
export function setDesignMode(document, value) {
  const state = asciiLower(value);
  if (state === 'on' || state === 'off') designModes.set(document, state);
}
export function contentEditable(element) {
  const value = element.getAttribute('contenteditable');
  if (value === null) return 'inherit';
  const state = asciiLower(value);
  return state === '' ? 'true' : ['true', 'false', 'plaintext-only'].includes(state) ? state : 'inherit';
}
export function setContentEditable(element, value) {
  const state = asciiLower(value);
  if (state === 'inherit') element.removeAttribute('contenteditable');
  else if (['true', 'false', 'plaintext-only'].includes(state)) element.setAttribute('contenteditable', state);
  else throw new DOMException('Invalid contentEditable value', 'SyntaxError');
}
export function isContentEditable(element) {
  for (let node = element; node; node = node.parentNode) {
    if (node.nodeType === 1) {
      const state = contentEditable(node);
      if (state !== 'inherit') return state !== 'false';
    } else if (node.nodeType === 9) return designMode(node) === 'on';
  }
  return false;
}

import HTMLOptionElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-option-element/HTMLOptionElement.ts';
import {nodeArray} from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const html = 'http://www.w3.org/1999/xhtml';
const svg = 'http://www.w3.org/2000/svg';

// HTML-aware text content is independent of CSS, layout and visibility. Walk
// iteratively so deeply nested options cannot exhaust the JavaScript stack.
// https://html.spec.whatwg.org/multipage/form-elements.html#the-option-element
export function optionText(element, includeAltText = false) {
  const text = [];
  const stack = [{children: element[nodeArray], index: 0}];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.children.length) { stack.pop(); continue; }
    const node = frame.children[frame.index++];
    let skip = false;
    if (node.nodeType === 3 || node.nodeType === 4) text.push(node.data);
    else if (node.nodeType === 1) {
      const namespace = node.namespaceURI;
      skip = node.localName === 'script' && (namespace === html || namespace === svg);
      if (namespace === html && node.localName === 'img') {
        if (includeAltText) text.push(node.getAttributeNS(null, 'alt') ?? '');
        skip = true;
      }
    }
    // Native nextSibling searches its parent's array on every call. Explicit
    // indices keep wide trees linear as well as avoiding recursive traversal.
    if (!skip && node[nodeArray].length) stack.push({children: node[nodeArray], index: 0});
  }
  // Only ASCII whitespace is collapsed; NBSP, VT and other Unicode spaces
  // retain their meaning. Collapse after concatenation across node boundaries.
  return text.join('').replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
}

export const optionValue = element => element.getAttributeNS(null, 'value') ?? optionText(element);
export const optionLabel = element => element.getAttributeNS(null, 'label') ?? optionText(element);

// The display label has a different empty-attribute rule from the IDL label
// getter, and may include image alternate text. It never depends on value.
export function optionDisplayLabel(element) {
  return element.getAttributeNS(null, 'label') || optionText(element, true);
}

Object.defineProperties(HTMLOptionElement.prototype, {
  text: { configurable: true, enumerable: true,
    get() { return optionText(this); },
    set(value) { this.textContent = `${value}`; },
  },
  label: { configurable: true, enumerable: true,
    get() { return optionLabel(this); },
    set(value) { this.setAttributeNS(null, 'label', `${value}`); },
  },
  value: { configurable: true, enumerable: true,
    get() { return optionValue(this); },
    set(value) { this.setAttributeNS(null, 'value', `${value}`); },
  },
});

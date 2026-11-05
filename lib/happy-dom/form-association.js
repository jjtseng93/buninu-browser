import HTMLFormElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-form-element/HTMLFormElement.ts';
import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLButtonElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-button-element/HTMLButtonElement.ts';
import HTMLFieldSetElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-field-set-element/HTMLFieldSetElement.ts';
import HTMLObjectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-object-element/HTMLObjectElement.ts';
import HTMLOutputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-output-element/HTMLOutputElement.ts';
import HTMLSelectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts';
import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';
import HTMLCollection from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/HTMLCollection.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {formOwner} from './radio-groups.js';

const html = 'http://www.w3.org/1999/xhtml';
const listed = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
const identity = node => node[S.proxy] ?? node;

function descendants(root, ids = null) {
  const result = [], stack = [...root[S.elementArray]].reverse();
  while (stack.length) {
    const element = stack.pop();
    if (ids) {
      const id = element.getAttributeNS(null, 'id');
      if (id && !ids.has(id)) ids.set(id, element);
    }
    if (element.namespaceURI === html && listed.has(element.localName)) result.push(identity(element));
    const children = element[S.elementArray];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return result;
}

// One owner algorithm serves page getters, native activation/submission,
// validation, reset, labels and radio grouping. No document-wide cache can go
// stale when ids, form attributes or the surrounding tree change.
for (const Type of [HTMLInputElement, HTMLButtonElement, HTMLFieldSetElement,
  HTMLObjectElement, HTMLOutputElement, HTMLSelectElement, HTMLTextAreaElement]) {
  Object.defineProperty(Type.prototype, 'form', {
    get() { return formOwner(this); }, configurable:true, enumerable:true,
  });
}

export function formControls(form) {
  form = identity(form);
  const ids = new Map();
  return descendants(form.getRootNode(), ids).filter(control => formOwner(control, ids) === form
    && !(control.localName === 'input' && control.type === 'image'));
}

export function fieldsetControls(fieldset) { return descendants(fieldset); }

HTMLFormElement.prototype[S.getFormControlItems] = function() { return formControls(this); };

const fieldsets = new WeakMap();
Object.defineProperty(HTMLFieldSetElement.prototype, 'elements', {
  get() {
    let collection = fieldsets.get(this);
    if (!collection) {
      collection = new HTMLCollection(S.illegalConstructor, () => fieldsetControls(this));
      fieldsets.set(this, collection);
    }
    return collection;
  }, configurable:true, enumerable:true,
});

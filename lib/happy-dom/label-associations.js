import HTMLLabelElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-label-element/HTMLLabelElement.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {formOwner} from './radio-groups.js';

const html = 'http://www.w3.org/1999/xhtml';
const labelable = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
const formAssociated = new Set(['button', 'input', 'output', 'select', 'textarea']);
const identity = node => node?.[S.proxy] ?? node;
const queries = new WeakMap();
const isLabel = node => node?.namespaceURI === html && node.localName === 'label';
export const isLabelable = node => node?.namespaceURI === html && labelable.has(node.localName)
  && !(node.localName === 'input' && node.type === 'hidden');

// Walk the DOM tree, including an element root but never entering its shadow
// tree. Detached roots and ShadowRoots have the same association rules.
function* elements(root, includeRoot = true) {
  const stack = includeRoot ? [root] : [...(root[S.elementArray] ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 1) yield identity(node);
    const children = node[S.elementArray] ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

// HTML's label association is based on tree order and exact attribute values,
// not CSS selectors. An explicit but unmatched for never falls back to children.
export function labelControl(label) {
  const id = label.getAttributeNS(null, 'for');
  if (id !== null) {
    if (!id) return null;
    for (const node of elements(label.getRootNode())) {
      if (node.getAttributeNS(null, 'id') === id) return isLabelable(node) ? node : null;
    }
    return null;
  }
  for (const node of elements(label, false)) if (isLabelable(node)) return node;
  return null;
}

function associatedLabels(control) {
  if (!isLabelable(control)) return [];
  const root = control.getRootNode(), id = control.getAttributeNS(null, 'id');
  const labels = [], implicit = [];
  let firstWithId = null;
  for (const node of elements(root)) {
    if (id && !firstWithId && node.getAttributeNS(null, 'id') === id) firstWithId = node;
    if (isLabel(node)) labels.push(node);
  }
  // Only ancestors can implicitly label this control. Resolve those once, then
  // retain tree order when merging them with explicit labels from the root.
  for (let node = control.parentElement; node; node = node.parentElement) {
    if (isLabel(node) && !node.hasAttributeNS(null, 'for') && labelControl(node) === control) implicit.push(identity(node));
  }
  return labels.filter(label => label.hasAttributeNS(null, 'for')
    ? id && firstWithId === control && label.getAttributeNS(null, 'for') === id
    : implicit.includes(label));
}

// BindingRealm.live and its existing NodeList implementation accept a query
// function. Keep that function's identity through hidden-state toggles/adoption;
// retained lists remain live without observers or a process-wide tree cache.
export function labelCollectionQuery(control) {
  control = identity(control);
  if (!isLabelable(control)) return null;
  let query = queries.get(control);
  if (!query) { query = () => associatedLabels(control); queries.set(control, query); }
  return query;
}

Object.defineProperties(HTMLLabelElement.prototype, {
  control: {get() { return labelControl(this); }, configurable: true, enumerable: true},
  form: {get() {
    const control = labelControl(this);
    return control && formAssociated.has(control.localName) ? formOwner(control) : null;
  }, configurable: true, enumerable: true},
  htmlFor: {
    get() { return this.getAttributeNS(null, 'for') ?? ''; },
    set(value) { this.setAttributeNS(null, 'for', value); },
    configurable: true, enumerable: true,
  },
});

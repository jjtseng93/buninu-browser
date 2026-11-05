import HTMLSelectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts';
import HTMLCollection from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/HTMLCollection.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {replaceNode} from './node-replacement.js';

// HTML's options collection operations mutate only the addressed option. The
// vendor implementation rebuilt all children, losing optgroups and other nodes.
export function addSelectOption(select, element, before = null) {
  if (element.contains(select)) throw new DOMException('The option is an ancestor of this select', 'HierarchyRequestError');
  if (before?.nodeType && (!select.contains(before) || before === select))
    throw new DOMException('The reference element is not a descendant of this select', 'NotFoundError');
  if (element === before) return;
  const reference = before?.nodeType ? before : Number.isInteger(before) ? select.options[before] ?? null : null;
  (reference?.parentNode ?? select).insertBefore(element, reference);
}

export function removeSelectOption(select, index) {
  const option = index >= 0 ? select.options[index] : null;
  if (option) option.parentNode.removeChild(option);
}

function appendBlankOptions(select, count) {
  const fragment = select.ownerDocument.createDocumentFragment();
  for (let i = 0; i < count; i++) fragment.appendChild(select.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'option'));
  select.appendChild(fragment);
}

export function setSelectLength(select, length) {
  const current = select.options.length;
  // This bound is specified by HTML, and also prevents enormous accidental allocations.
  if (length > current) {
    if (length <= 100000) appendBlankOptions(select, length - current);
  } else if (length < current) {
    const remove = Array.from(select.options).slice(length);
    for (const option of remove) option.parentNode.removeChild(option);
  }
}

export function setSelectOption(select, index, option) {
  if (option === null) return removeSelectOption(select, index);
  const length = select.options.length;
  // Match browser resource limits for sparse writes as well as length growth.
  if (index > length && index >= 100000) return;
  if (index > length) appendBlankOptions(select, index - length);
  if (index >= length) select.appendChild(option);
  else {
    const previous = select.options[index];
    replaceNode(previous.parentNode, option, previous);
  }
}

HTMLSelectElement.prototype.add = function(element, before = null) { addSelectOption(this, element, before); };
const remove = HTMLSelectElement.prototype.remove;
HTMLSelectElement.prototype.remove = function(index) {
  if (!arguments.length) return remove.call(this);
  removeSelectOption(this, index);
};
const length = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'length');
Object.defineProperty(HTMLSelectElement.prototype, 'length', { ...length,
  set(value) { setSelectLength(this, Number(value) >>> 0); },
});

// The vendor's multiple-selected branch used the number of selected items as
// an index into all options, choosing an unrelated option when gaps existed.
// Apply HTML's selectedness setting algorithm using node identity instead.
HTMLSelectElement.prototype[S.updateSelectedness] = function(selectedOption) {
  const options = Array.from(this.options);
  if (this.hasAttributeNS(null, 'multiple')) {
    this[S.selectedIndex] = options.findIndex(option => option[S.selectedness]);
    return;
  }
  let selected = null, firstEnabled = null;
  for (const option of options) {
    if (selectedOption) option[S.selectedness] = option === selectedOption;
    if (option[S.selectedness]) {
      if (selected) selected[S.selectedness] = false;
      selected = option;
    }
    const parent = option.parentElement;
    if (!firstEnabled && !option.hasAttributeNS(null, 'disabled')
      && !(parent?.localName === 'optgroup' && parent.namespaceURI === 'http://www.w3.org/1999/xhtml' && parent.hasAttributeNS(null, 'disabled')))
      firstEnabled = option;
  }
  const sizeText = this.getAttributeNS(null, 'size');
  // A zero size has the same display-size default as an omitted size (one
  // for a non-multiple select), despite the reflected size getter returning 0.
  const size = (/^[\t\n\f\r ]*\+?\d/.test(sizeText ?? '') ? Number.parseInt(sizeText, 10) : 1) || 1;
  if (!selected && firstEnabled && size === 1) { firstEnabled[S.selectedness] = true; selected = firstEnabled; }
  this[S.selectedIndex] = options.indexOf(selected);
};

// Membership depends on selectedness as well as DOM mutations. The vendor's
// cached query result outlives selectedIndex/value changes and therefore goes stale.
const selected = new WeakMap();
Object.defineProperty(HTMLSelectElement.prototype, 'selectedOptions', {
  configurable:true, enumerable:true,
  get() {
    const select = this[S.proxy] ?? this;
    let collection = selected.get(select);
    if (!collection) {
      collection = new HTMLCollection(S.illegalConstructor, () => Array.from(select.options).filter(option => option[S.selectedness]));
      selected.set(select, collection);
    }
    return collection;
  },
});

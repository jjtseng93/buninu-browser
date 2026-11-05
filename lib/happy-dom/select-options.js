import { optionDisabled } from './form-disabled.js';
import './node-document-transfer.js';
import HTMLSelectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts';
import HTMLOptionElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-option-element/HTMLOptionElement.ts';
import HTMLCollection from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/HTMLCollection.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {replaceNode} from './node-replacement.js';

// The reflected IDL value defaults to zero; the effective single/multiple
// display size defaults to one/four. Keep validation and selectedness aligned.
function parseSelectSize(text = '') {
  const number = /^[\t\n\f\r ]*\+?\d/.test(text) ? Number.parseInt(text, 10) : 0;
  return number <= 2147483647 ? number : 0;
}

export function selectSize(select) {
  return parseSelectSize(select.getAttributeNS(null, 'size') ?? '');
}

export function selectDisplaySize(select) {
  return selectSize(select) || (select.hasAttributeNS(null, 'multiple') ? 4 : 1);
}

Object.defineProperty(HTMLSelectElement.prototype, 'size', { configurable: true, enumerable: true,
  get() { return selectSize(this); },
  set(value) {
    const number = Number(value) >>> 0;
    this.setAttributeNS(null, 'size', String(number <= 2147483647 ? number : 0));
  },
});

for (const name of ['required', 'multiple']) {
  Object.defineProperty(HTMLSelectElement.prototype, name, { configurable: true, enumerable: true,
    get() { return this.hasAttributeNS(null, name); },
    set(value) {
      if (value) this.setAttributeNS(null, name, '');
      else this.removeAttributeNS(null, name);
    },
  });
}

for (const hook of [S.onSetAttribute, S.onRemoveAttribute]) {
  const original = HTMLSelectElement.prototype[hook];
  HTMLSelectElement.prototype[hook] = function(attribute, ...args) {
    const previous = hook === S.onRemoveAttribute ? attribute : args[0];
    const oldSize = parseSelectSize(previous?.[S.value] ?? '');
    const result = original.call(this, attribute, ...args);
    // An equivalent size assignment must not undo selectedIndex = -1.
    if (attribute[S.namespaceURI] === null && attribute[S.localName] === 'size' && oldSize !== selectSize(this))
      this[S.updateSelectedness]();
    return result;
  };
}

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
  // Connection hooks run after insertion but before the parent's mutation
  // report. Walk the current elements rather than a stale cached selector.
  // Forcing a new selector cache on every selection also accumulated dead
  // dependency records on the document and unchanged option nodes.
  const options = [];
  const stack = [{children:this[S.elementArray], index:0}];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.children.length) { stack.pop(); continue; }
    const node = frame.children[frame.index++];
    if (node.localName === 'option') options.push(node);
    if (node[S.elementArray].length) stack.push({children:node[S.elementArray], index:0});
  }
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
    if (!firstEnabled && !optionDisabled(option))
      firstEnabled = option;
  }
  if (!selected && firstEnabled && selectDisplaySize(this) === 1) { firstEnabled[S.selectedness] = true; selected = firstEnabled; }
  this[S.selectedIndex] = options.indexOf(selected);
};

// Inserting a selected option into a single-select selects the incoming node,
// including when it precedes the old selection. The vendor's connection hook
// just resets the group, losing which selected option triggered the insertion.
const connectedOption = HTMLOptionElement.prototype[S.connectedToNode];
HTMLOptionElement.prototype[S.connectedToNode] = function(...args) {
  const wasSelected = this[S.selectedness];
  const result = connectedOption.apply(this, args);
  if (wasSelected && this[S.selectNode]) this[S.selectNode][S.updateSelectedness](this);
  return result;
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

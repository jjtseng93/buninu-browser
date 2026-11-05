import {addSelectOption, removeSelectOption, setSelectLength, setSelectOption} from '../happy-dom/select-options.js';

const html = 'http://www.w3.org/1999/xhtml';
const isElement = (node, names) => node?.namespaceURI === html && names.includes(node.localName);

// Share HTMLCollection's legacy indexed/named getter machinery while keeping
// write access exclusive to HTMLOptionsCollection. Engine nodes never escape.
export function optionsCollectionInterface({base, unwrap, wrap, global = () => globalThis, changed}) {
  const states = new WeakMap();
  const error = message => new (global().TypeError)(message);
  const stateOf = self => {
    const select = states.get(self);
    if (!select) throw error('Illegal invocation');
    return select;
  };
  function number(value) {
    const object = v => v !== null && (typeof v === 'object' || typeof v === 'function');
    if (object(value)) {
      const exotic = value[Symbol.toPrimitive];
      if (exotic != null) {
        if (typeof exotic !== 'function') throw error('Invalid primitive converter');
        value = Reflect.apply(exotic, value, ['number']);
      } else {
        const original = value;
        for (const key of ['valueOf', 'toString']) {
          const method = original[key];
          if (typeof method === 'function') {
            value = Reflect.apply(method, original, []);
            if (!object(value)) break;
          }
        }
      }
    }
    if (object(value) || typeof value === 'symbol' || typeof value === 'bigint') throw error('Cannot convert to a number');
    return Number(value);
  }
  const optionNode = value => {
    const node = unwrap(value);
    if (!isElement(node, ['option'])) throw error('The value must be an HTMLOptionElement');
    return node;
  };
  function add(select, element, before, count) {
    if (!count) throw error('add requires an option or optgroup');
    const node = unwrap(element);
    if (!isElement(node, ['option', 'optgroup'])) throw error('The element must be an option or optgroup');
    const candidate = before == null ? null : unwrap(before);
    const reference = before == null ? null : candidate?.nodeType === 1 && candidate.namespaceURI === html ? candidate : number(before) | 0;
    addSelectOption(select, node, reference);
    changed(select, node);
  }
  function remove(select, index, count) {
    if (!count) throw error('remove requires an index');
    removeSelectOption(select, number(index) | 0);
    changed(select);
  }
  function setLength(select, value) { setSelectLength(select, number(value) >>> 0); changed(select); }
  function setSelectedIndex(select, value) { select.selectedIndex = number(value) | 0; changed(select); }
  function HTMLOptionsCollection() { throw error('Illegal constructor'); }
  Object.setPrototypeOf(HTMLOptionsCollection, base.HTMLCollection);
  HTMLOptionsCollection.prototype = Object.create(base.HTMLCollection.prototype);
  Object.defineProperties(HTMLOptionsCollection.prototype, {
    constructor: {value:HTMLOptionsCollection, writable:true, configurable:true},
    length: {get() { return stateOf(this).options.length; }, set(value) { setLength(stateOf(this), value); }, enumerable:true, configurable:true},
    selectedIndex: {get() { return stateOf(this).selectedIndex; }, set(value) { setSelectedIndex(stateOf(this), value); }, enumerable:true, configurable:true},
    add: {value:function addOption(element, before = null) { add(stateOf(this), element, before, arguments.length); }, writable:true, enumerable:true, configurable:true},
    remove: {value:function removeOption(index) { remove(stateOf(this), index, arguments.length); }, writable:true, enumerable:true, configurable:true},
    [Symbol.toStringTag]: {value:'HTMLOptionsCollection', configurable:true},
  });
  Object.defineProperty(HTMLOptionsCollection, 'prototype', {writable:false});
  return {
    HTMLOptionsCollection, add, remove, setLength, setSelectedIndex,
    item(select, index, count) { return base.item(select.options, wrap, number(index) >>> 0, count); },
    namedItem(select, name, count) { return base.namedItem(select.options, wrap, name, count); },
    create(select) {
      const view = base.create(select.options, wrap, {prototype:HTMLOptionsCollection.prototype,
        setIndex(index, value) {
          const node = value == null ? null : optionNode(value);
          setSelectOption(select, index, node);
          changed(select, node);
        },
      });
      states.set(view, select);
      return view;
    },
  };
}

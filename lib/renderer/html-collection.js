import {encodingString} from './encoding-string.js';

const states = new WeakMap();
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const isIndex = key => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;

// HTMLCollection is a live legacy platform object, not an Array: it has
// indexed and named getters, but only @@iterator (no values/map/forEach).
export function htmlCollectionInterface(global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  const stateOf = self => {
    const state = states.get(self);
    if (!state) throw error('TypeError', 'Illegal invocation');
    return state;
  };
  const at = (state, index) => index < state.collection.length ? state.wrap(state.collection[index]) : undefined;
  const named = (state, name) => {
    if (!name) return null;
    for (const node of state.collection) {
      if (node.getAttribute('id') === name || (node.namespaceURI === htmlNamespace && node.getAttribute('name') === name))
        return state.wrap(node);
    }
    return null;
  };
  function HTMLCollection() { throw error('TypeError', 'Illegal constructor'); }
  Object.defineProperties(HTMLCollection.prototype, {
    length: {get() { return stateOf(this).collection.length; }, enumerable:true, configurable:true},
    item: {value: function item(index) {
      const state = stateOf(this);
      if (!arguments.length) throw error('TypeError', 'item requires an index');
      return at(state, Number(index) >>> 0) ?? null;
    }, writable:true, enumerable:true, configurable:true},
    namedItem: {value: function namedItem(name) {
      const state = stateOf(this);
      if (!arguments.length) throw error('TypeError', 'namedItem requires a name');
      return named(state, encodingString(name, error));
    }, writable:true, enumerable:true, configurable:true},
    [Symbol.iterator]: {value:Array.prototype.values, writable:true, configurable:true},
    [Symbol.toStringTag]: {value:'HTMLCollection', configurable:true},
  });
  Object.defineProperty(HTMLCollection, 'prototype', {writable:false});

  function create(collection, wrap) {
    const state = {collection, wrap};
    const target = Object.create(HTMLCollection.prototype);
    const visibleName = key => typeof key === 'string' && !isIndex(key) && !Reflect.has(target, key) ? named(state, key) : null;
    let view;
    view = new Proxy(target, {
      get(target, key, receiver) {
        if (isIndex(key) && Number(key) < collection.length) return at(state, Number(key));
        const value = visibleName(key);
        return value ?? Reflect.get(target, key, receiver);
      },
      has(target, key) {
        return (isIndex(key) && Number(key) < collection.length) || visibleName(key) !== null || Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (isIndex(key) && Number(key) < collection.length)
          return {value:at(state, Number(key)), writable:false, enumerable:true, configurable:true};
        const value = visibleName(key);
        return value !== null ? {value, writable:false, enumerable:false, configurable:true} : Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        const keys = new Set(Array.from({length:collection.length}, (_, i) => String(i)));
        for (const node of collection) {
          for (const name of [node.getAttribute('id'), node.namespaceURI === htmlNamespace ? node.getAttribute('name') : null])
            if (name && !isIndex(name) && !Reflect.has(target, name)) keys.add(name);
        }
        for (const key of Reflect.ownKeys(target)) keys.add(key);
        return [...keys];
      },
      set(target, key, value, receiver) {
        if (receiver === view && (isIndex(key) || visibleName(key) !== null)) return false;
        return Reflect.set(target, key, value, receiver);
      },
      defineProperty(target, key, descriptor) {
        if (isIndex(key) || visibleName(key) !== null) return false;
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) {
        if ((isIndex(key) && Number(key) < collection.length) || visibleName(key) !== null) return false;
        return Reflect.deleteProperty(target, key);
      },
      // Live virtual properties cannot satisfy a non-extensible target's invariants.
      preventExtensions() { return false; },
    });
    states.set(view, state);
    return view;
  }
  return {HTMLCollection, create};
}

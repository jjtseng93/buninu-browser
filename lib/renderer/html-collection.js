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
  const at = (state, index) => {
    const collection = state.collection;
    return index < collection.length ? state.wrap(collection[index]) : undefined;
  };
  const named = (state, name) => {
    if (!name) return null;
    for (const node of state.collection) {
      if (node.getAttributeNS(null, 'id') === name || (node.namespaceURI === htmlNamespace && node.getAttributeNS(null, 'name') === name))
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

  function create(collection, wrap, {prototype = HTMLCollection.prototype, setIndex, named: namedLookup} = {}) {
    const state = {wrap, named:namedLookup};
    Object.defineProperty(state, 'collection', {get:() => typeof collection === 'function' ? collection() : collection});
    const target = Object.create(prototype);
    const visibleName = key => typeof key === 'string' && !isIndex(key) && !Reflect.has(target, key)
      ? state.named ? state.named(key) : named(state, key) : null;
    let view;
    view = new Proxy(target, {
      get(target, key, receiver) {
        if (isIndex(key)) {
          const nodes = state.collection, index = Number(key);
          if (index < nodes.length) return state.wrap(nodes[index]);
        }
        const value = visibleName(key);
        return value ?? Reflect.get(target, key, receiver);
      },
      has(target, key) {
        return (isIndex(key) && Number(key) < state.collection.length) || visibleName(key) !== null || Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (isIndex(key)) {
          const nodes = state.collection, index = Number(key);
          if (index < nodes.length) return {value:state.wrap(nodes[index]), writable:!!setIndex, enumerable:true, configurable:true};
        }
        const value = visibleName(key);
        return value !== null ? {value, writable:false, enumerable:false, configurable:true} : Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        const nodes = state.collection;
        const keys = new Set(Array.from({length:nodes.length}, (_, i) => String(i)));
        for (const node of nodes) {
          for (const name of [node.getAttributeNS(null, 'id'), node.namespaceURI === htmlNamespace ? node.getAttributeNS(null, 'name') : null])
            if (name && !isIndex(name) && !Reflect.has(target, name)) keys.add(name);
        }
        for (const key of Reflect.ownKeys(target)) keys.add(key);
        return [...keys];
      },
      set(target, key, value, receiver) {
        if (receiver === view && isIndex(key) && setIndex) { setIndex(Number(key), value); return true; }
        if (receiver === view && (isIndex(key) || visibleName(key) !== null)) return false;
        return Reflect.set(target, key, value, receiver);
      },
      defineProperty(target, key, descriptor) {
        if (isIndex(key) && setIndex) {
          if ('get' in descriptor || 'set' in descriptor || descriptor.configurable === false) return false;
          setIndex(Number(key), descriptor.value); return true;
        }
        if (isIndex(key) || visibleName(key) !== null) return false;
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) {
        if ((isIndex(key) && Number(key) < state.collection.length) || visibleName(key) !== null) return false;
        return Reflect.deleteProperty(target, key);
      },
      // Live virtual properties cannot satisfy a non-extensible target's invariants.
      preventExtensions() { return false; },
    });
    states.set(view, state);
    return view;
  }
  return {HTMLCollection, create,
    item(collection, wrap, index, count) {
      if (!count) throw error('TypeError', 'item requires an index');
      return at({collection, wrap}, Number(index) >>> 0) ?? null;
    },
    namedItem(collection, wrap, name, count) {
      if (!count) throw error('TypeError', 'namedItem requires a name');
      return named({collection, wrap}, encodingString(name, error));
    },
  };
}

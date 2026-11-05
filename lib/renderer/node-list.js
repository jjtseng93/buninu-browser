const lists = new WeakMap();
const indexKey = key => {
  if (typeof key !== 'string') return -1;
  const first = key.charCodeAt(0) - 48;
  if (!(first >= 0 && first <= 9)) return -1;
  if (key.length === 1) return first;
  if (first === 0 || key.length > 10 || /\D/.test(key)) return -1;
  const index = Number(key);
  return index < 0xffffffff ? index : -1;
};

export function nodeListInterface(global = () => globalThis) {
  const typeError = message => new (global().TypeError)(message);
  const stateOf = self => {
    const state = lists.get(self);
    if (!state) throw typeError('Illegal invocation');
    return state;
  };
  const at = (state, nodes, index) => {
    // Only an explicitly static snapshot may cache by index. Live collections
    // can replace or move their nodes without changing the collection object.
    if (state.cache) return state.cache[index] ??= state.wrap(nodes[index]);
    return state.wrap(nodes[index]);
  };
  function NodeList() { throw typeError('Illegal constructor'); }
  Object.defineProperties(NodeList.prototype, {
    length: {get() {return stateOf(this).nodes.length;}, configurable:true, enumerable:true},
    item: {value:function item(index) {
      const state = stateOf(this);
      if (!arguments.length) throw typeError('item requires an index');
      const value = Number(index) >>> 0, nodes = state.nodes;
      return value < nodes.length ? at(state, nodes, value) ?? null : null;
    }, writable:true, configurable:true, enumerable:true},
    [Symbol.toStringTag]: {value:'NodeList', configurable:true},
  });
  Object.defineProperty(NodeList, 'prototype', {writable:false});
  function setArrayMethods(ArrayPrototype) {
    for (const key of ['entries','keys','values','forEach',Symbol.iterator])
      Object.defineProperty(NodeList.prototype, key, {value:ArrayPrototype[key], writable:true, enumerable:true, configurable:true});
  }
  setArrayMethods(Array.prototype);
  function create(nodes, wrap, {static: isStatic = false} = {}) {
    const cache = isStatic ? Object.create(null) : null;
    const state = {wrap,cache}, target = Object.create(NodeList.prototype);
    // A collection object is already live through its own length and indices;
    // only query-backed lists need to obtain a fresh collection on each read.
    if (typeof nodes === 'function') Object.defineProperty(state, 'nodes', {get:() => nodes()});
    else state.nodes = nodes;
    let view;
    view = new Proxy(target, {
      get(target,key,receiver) {
        // Only validated, supported indices enter this private dictionary.
        // Repeated static reads avoid parsing the key and wrapping the node.
        // A null prototype keeps length, symbols and expandos on Reflect.get.
        const cached = cache?.[key];
        if (cached !== undefined) return cached;
        const index = indexKey(key);
        if (index >= 0) {
          const nodes = state.nodes;
          if (index < nodes.length) return at(state,nodes,index);
        }
        return Reflect.get(target,key,receiver);
      },
      has(target,key) {
        if (cache?.[key] !== undefined) return true;
        const index = indexKey(key);
        return index >= 0 && index < state.nodes.length || Reflect.has(target,key);
      },
      getOwnPropertyDescriptor(target,key) {
        const index = indexKey(key);
        if (index >= 0) {
          const nodes = state.nodes;
          if (index < nodes.length) return {value:at(state,nodes,index), writable:false, enumerable:true, configurable:true};
        }
        return Reflect.getOwnPropertyDescriptor(target,key);
      },
      ownKeys(target) {return [...Array.from({length:state.nodes.length},(_,i)=>String(i)),...Reflect.ownKeys(target)];},
      set(target,key,value,receiver) {
        if (receiver === view && indexKey(key) >= 0) return false;
        return Reflect.set(target,key,value,receiver);
      },
      defineProperty(target,key,descriptor) {return indexKey(key) < 0 && Reflect.defineProperty(target,key,descriptor);},
      deleteProperty(target,key) {
        const index = indexKey(key);
        return !(index >= 0 && index < state.nodes.length) && Reflect.deleteProperty(target,key);
      },
      preventExtensions() {return false;},
    });
    lists.set(view,state);
    return view;
  }
  return {NodeList,create,setArrayMethods};
}

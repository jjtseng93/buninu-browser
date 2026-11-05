const lists = new WeakMap();
const indexKey = key => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;

export function nodeListInterface(global = () => globalThis) {
  const typeError = message => new (global().TypeError)(message);
  const stateOf = self => {
    const state = lists.get(self);
    if (!state) throw typeError('Illegal invocation');
    return state;
  };
  const at = (state, index) => index < state.nodes.length ? state.wrap(state.nodes[index]) : undefined;
  function NodeList() { throw typeError('Illegal constructor'); }
  Object.defineProperties(NodeList.prototype, {
    length: {get() {return stateOf(this).nodes.length;}, configurable:true, enumerable:true},
    item: {value:function item(index) {
      const state = stateOf(this);
      if (!arguments.length) throw typeError('item requires an index');
      return at(state, Number(index) >>> 0) ?? null;
    }, writable:true, configurable:true, enumerable:true},
    [Symbol.toStringTag]: {value:'NodeList', configurable:true},
  });
  Object.defineProperty(NodeList, 'prototype', {writable:false});
  function setArrayMethods(ArrayPrototype) {
    for (const key of ['entries','keys','values','forEach',Symbol.iterator])
      Object.defineProperty(NodeList.prototype, key, {value:ArrayPrototype[key], writable:true, enumerable:true, configurable:true});
  }
  setArrayMethods(Array.prototype);
  function create(nodes, wrap) {
    const source = typeof nodes === 'function' ? nodes : () => nodes;
    const state = {get nodes() {return source();},wrap}, target = Object.create(NodeList.prototype);
    let view;
    view = new Proxy(target, {
      get(target,key,receiver) {
        return indexKey(key) && Number(key) < state.nodes.length ? at(state, Number(key)) : Reflect.get(target,key,receiver);
      },
      has(target,key) {return indexKey(key) && Number(key) < state.nodes.length || Reflect.has(target,key);},
      getOwnPropertyDescriptor(target,key) {
        return indexKey(key) && Number(key) < state.nodes.length
          ? {value:at(state,Number(key)), writable:false, enumerable:true, configurable:true}
          : Reflect.getOwnPropertyDescriptor(target,key);
      },
      ownKeys(target) {return [...Array.from({length:state.nodes.length},(_,i)=>String(i)),...Reflect.ownKeys(target)];},
      set(target,key,value,receiver) {
        if (receiver === view && indexKey(key)) return false;
        return Reflect.set(target,key,value,receiver);
      },
      defineProperty(target,key,descriptor) {return !indexKey(key) && Reflect.defineProperty(target,key,descriptor);},
      deleteProperty(target,key) {return !(indexKey(key) && Number(key) < state.nodes.length) && Reflect.deleteProperty(target,key);},
      preventExtensions() {return false;},
    });
    lists.set(view,state);
    return view;
  }
  return {NodeList,create,setArrayMethods};
}

// Mutable boxed-primitive prototypes belong to one page, never SES's shared
// frozen intrinsics. This module receives only the page's tamed globals.
export function installPagePrimitiveBuiltins(compartment, pageGlobal) {
  const prototypes = new Map(), boundMethods = new WeakMap();
  for (const name of ['Number', 'String', 'Boolean']) {
    const Base = pageGlobal[name];
    const Local = compartment.evaluate(`((Base, construct) => function ${name}(...args) {
      return new.target ? construct(Base, args, new.target) : Base(...args);
    })(${name}, Reflect.construct)`);
    const prototype = Reflect.construct(Base, [name === 'String' ? '' : name === 'Boolean' ? false : 0]);
    for (const key of Reflect.ownKeys(Base.prototype)) {
      if (key === 'constructor' || Object.hasOwn(prototype, key)) continue;
      const descriptor = {...Object.getOwnPropertyDescriptor(Base.prototype, key), configurable: true};
      if ('value' in descriptor) descriptor.writable = true;
      Object.defineProperty(prototype, key, descriptor);
    }
    Object.setPrototypeOf(prototype, Object.getPrototypeOf(Base.prototype));
    Object.defineProperty(prototype, 'constructor', {value: Local, writable: true, configurable: true});
    Object.defineProperty(Local, 'prototype', {value: prototype});
    Object.defineProperty(Local, 'length', {value: 1, configurable: true});
    for (const key of Reflect.ownKeys(Base)) if (!['name', 'length', 'prototype'].includes(key))
      Object.defineProperty(Local, key, {...Object.getOwnPropertyDescriptor(Base, key), configurable: true});
    const ordinaryHasInstance=Function.prototype[Symbol.hasInstance];
    Object.defineProperty(Local,Symbol.hasInstance,{value(value){
      return Reflect.apply(ordinaryHasInstance,this,[value]) || this===Local && Reflect.apply(ordinaryHasInstance,Base,[value]);
    },configurable:true});
    pageGlobal[name] = Local;
    prototypes.set(name.toLowerCase(), prototype);
  }
  // Return actual values for ordinary reads and retain the original receiver
  // for method calls, including strict functions invoked on primitive values.
  return (receiver, key, call = false) => {
    key = typeof key === 'string' || typeof key === 'symbol' ? key : Reflect.ownKeys({[key]:0})[0];
    const type = typeof receiver, primitive = prototypes.get(type);
    let value;
    if (primitive) {
      const indexedString = type === 'string' && (key === 'length' || /^(0|[1-9]\d*)$/.test(String(key)));
      value = indexedString ? Reflect.get(Object(receiver), key, receiver) : Reflect.get(primitive, key, receiver);
    } else {
      // Null/undefined throw normally. Never replace or mutate a host prototype.
      if(receiver===null||receiver===undefined)throw new TypeError('Cannot read property '+String(key)+' of '+receiver);
      value = receiver[key];
      if (value === undefined && !Object.hasOwn(Object(receiver), key)) {
        const local = Array.isArray(receiver) ? pageGlobal.Array.prototype
          : type === 'function' ? pageGlobal.Function.prototype : null;
        if (local && Object.hasOwn(local, key)) value = Reflect.get(local, key, receiver);
      }
    }
    if (!call || typeof value !== 'function') return value;
    if (receiver !== null && (type === 'object' || type === 'function')) {
      let methods=boundMethods.get(receiver);
      if(!methods){methods=new WeakMap();boundMethods.set(receiver,methods);}
      let bound=methods.get(value);
      if(!bound){const fn=value;bound=(...args)=>Reflect.apply(fn,receiver,args);methods.set(fn,bound);}
      return bound;
    }
    return (...args)=>Reflect.apply(value,receiver,args);
  };
}

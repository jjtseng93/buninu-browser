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
  const slow = (receiver, key, call = false) => {
    // The key expression has already run, but nullish receivers fail before
    // ToPropertyKey. Use the native read so an object key cannot run coercion
    // hooks (or replace the TypeError) while preparing the error message.
    if (receiver === null || receiver === undefined) return receiver[key];
    if (!call) {
      // Primitive strings own their UTF-16 length and in-range characters.
      // Native reads need neither boxing nor the mutable-prototype bridge.
      if (typeof receiver === 'string') {
        if (key === 'length') return receiver.length;
        if (typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < receiver.length) return receiver[key];
      }
    }
    // Primitive keys need only ToString (symbols are already property keys).
    // Array/typed-array loops must not allocate a temporary object and key
    // array for every numeric index. Keep native ToPropertyKey for objects:
    // it preserves the string hint, symbol results and throwing conversions.
    if (typeof key !== 'string' && typeof key !== 'symbol') {
      key = key === null || typeof key !== 'object' && typeof key !== 'function'
        ? String(key) : Reflect.ownKeys({[key]:0})[0];
    }
    const type = typeof receiver, primitive = prototypes.get(type);
    let value;
    if (primitive) {
      // Only canonical, in-range UTF-16 indices are own string properties.
      // Ordinary method names need no regexp (whose SES wrapper is costly),
      // and noncanonical/out-of-range keys still use the page's prototype.
      let indexedString = type === 'string' && key === 'length';
      if (type === 'string' && !indexedString && typeof key === 'string') {
        const first = key.charCodeAt(0);
        if (first >= 48 && first <= 57) {
          const index = Number(key);
          indexedString = Number.isInteger(index) && index >= 0 && index < receiver.length && String(index) === key;
        }
      }
      value = indexedString ? receiver[key] : Reflect.get(primitive, key, receiver);
    } else {
      // Never replace or mutate a host prototype.
      value = receiver[key];
      if (value === undefined) {
        const local = Array.isArray(receiver) ? pageGlobal.Array.prototype
          : type === 'function' ? pageGlobal.Function.prototype : null;
        if (local && !Object.hasOwn(receiver, key) && Object.hasOwn(local, key)) value = Reflect.get(local, key, receiver);
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
  // Most rewritten member reads are ordinary objects with literal keys.
  // Keep this entry small enough to inline; primitive bridges, observable
  // object-key conversion and receiver-preserving calls retain the full path.
  return (receiver, key, call = false) => {
    if (!call && receiver !== null && typeof receiver === 'object'
      && (key === null || typeof key !== 'object' && typeof key !== 'function')) {
      const value = receiver[key];
      // Only arrays need the local-prototype fallback. An ordinary Proxy read
      // must not invoke getOwnPropertyDescriptor after its get trap returns
      // undefined; that extra inspection is both observable and unnecessary.
      if (value === undefined && Array.isArray(receiver) && !Object.hasOwn(receiver, key)
        && Object.hasOwn(pageGlobal.Array.prototype, key)) return Reflect.get(pageGlobal.Array.prototype, key, receiver);
      return value;
    }
    return slow(receiver, key, call);
  };
}

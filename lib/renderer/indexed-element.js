// An element with Web IDL indexed getter/setter semantics (HTMLSelectElement).
// Only page-facing values cross this proxy; native nodes remain in the binding.
export function indexedElement(target, {length, get, set}) {
  const index = key => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;
  const supported = key => index(key) && Number(key) < length();
  let view;
  view = new Proxy(target, {
    get(target, key, receiver) {
      return supported(key) ? get(Number(key)) : Reflect.get(target, key, receiver);
    },
    has(target, key) { return supported(key) || Reflect.has(target, key); },
    ownKeys(target) {
      return [...Array.from({length:length()}, (_, i) => String(i)), ...Reflect.ownKeys(target)];
    },
    getOwnPropertyDescriptor(target, key) {
      return supported(key) ? {value:get(Number(key)), writable:true, enumerable:true, configurable:true}
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(target, key, value, receiver) {
      if (view === receiver && index(key)) { set(Number(key), value); return true; }
      // An inherited supported index is an own writable data property, even
      // when the prototype has an accessor with the same numeric name.
      if (supported(key) && view !== receiver) {
        if (receiver === null || !['object', 'function'].includes(typeof receiver)) return false;
        const own = Reflect.getOwnPropertyDescriptor(receiver, key);
        if (own && (!('value' in own) || !own.writable)) return false;
        return Reflect.defineProperty(receiver, key, own ? {value} : {value,writable:true,enumerable:true,configurable:true});
      }
      return Reflect.set(target, key, value, receiver);
    },
    defineProperty(target, key, descriptor) {
      if (!index(key)) return Reflect.defineProperty(target, key, descriptor);
      // Virtual live indices cannot become permanent own properties on a JS
      // Proxy target. Keep the same invariant guard as HTMLOptionsCollection.
      if ('get' in descriptor || 'set' in descriptor || !('value' in descriptor || 'writable' in descriptor)
        || descriptor.configurable === false) return false;
      set(Number(key), descriptor.value);
      return true;
    },
    deleteProperty(target, key) { return supported(key) ? false : Reflect.deleteProperty(target, key); },
    preventExtensions() { return false; },
  });
  return view;
}

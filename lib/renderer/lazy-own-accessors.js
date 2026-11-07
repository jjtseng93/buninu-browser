// Preserve an object's own accessor shape without installing hundreds of
// descriptors for callers that only read one property. Reflection and writes
// materialize the original descriptors before applying ordinary object rules.
export function lazyOwnAccessors(target, descriptors, setUnknown) {
  let materialized = false;
  const materialize = () => {
    if (!materialized) {
      Object.defineProperties(target, descriptors);
      materialized = true;
    }
  };
  return new Proxy(target, {
    get(target, property, receiver) {
      if (!materialized && Object.hasOwn(descriptors, property))
        return Reflect.apply(descriptors[property].get, receiver, []);
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return !materialized && Object.hasOwn(descriptors, property) || Reflect.has(target, property);
    },
    set(target, property, value, receiver) {
      if (!materialized && Object.hasOwn(descriptors, property)) {
        const setter = descriptors[property].set;
        if (!setter) return false;
        Reflect.apply(setter, receiver, [value]);
        return true;
      }
      if (setUnknown) setUnknown(target, property);
      materialize();
      return Reflect.set(target, property, value, receiver);
    },
    ownKeys(target) { materialize(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, property) {
      materialize(); return Reflect.getOwnPropertyDescriptor(target, property);
    },
    defineProperty(target, property, descriptor) {
      materialize(); return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      materialize(); return Reflect.deleteProperty(target, property);
    },
    preventExtensions(target) { materialize(); return Reflect.preventExtensions(target); },
  });
}

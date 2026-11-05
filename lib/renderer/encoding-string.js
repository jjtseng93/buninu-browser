// WebIDL DOMString conversion: user code exceptions retain their identity.
const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
export function encodingString(value, error) {
  if (isObject(value)) {
    const exotic = value[Symbol.toPrimitive];
    if (exotic != null) {
      if (typeof exotic !== 'function') throw error('TypeError', 'Invalid primitive converter');
      value = Reflect.apply(exotic, value, ['string']);
    } else {
      const object = value;
      for (const key of ['toString', 'valueOf']) {
        const method = object[key];
        if (typeof method === 'function') {
          value = Reflect.apply(method, object, []);
          if (!isObject(value)) break;
        }
      }
    }
    if (isObject(value)) throw error('TypeError', 'Cannot convert object to primitive');
  }
  if (typeof value === 'symbol') throw error('TypeError', 'Cannot convert a Symbol to a string');
  return String(value);
}

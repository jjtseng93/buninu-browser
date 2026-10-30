// HTML named access on Window. Keep names on the per-document prototype,
// below explicit window properties, and resolve the live document at access
// time so renaming/removing an element never leaves a stale global behind.
export function windowNamedProperties(document, realm, prototype) {
  const namedTags = new Set(['EMBED', 'FORM', 'IMG', 'OBJECT']);
  const collections = new Map();
  function matches(name) {
    if (!name || typeof name !== 'string') return [];
    // Most missing global reads are not DOM names. Avoid walking the tree for them.
    if (!document.getElementById(name) && !document.getElementsByName(name).length) return [];
    return [...document.querySelectorAll('[id], [name]')].filter(element =>
      element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      (element.id === name || (namedTags.has(element.tagName) || element.tagName === 'IFRAME') && element.getAttribute('name') === name));
  }
  function value(name, items) {
    const frame = items.find(e => e.tagName === 'IFRAME' && e.getAttribute('name') === name);
    if (frame) return realm.wrap(frame).contentWindow;
    if (items.length === 1) return realm.wrap(items[0]);
    let collection = collections.get(name);
    if (!collection) {
      collection = realm.live(new Proxy({}, {
        get(_target, key) {
          const current = matches(name);
          if (key === 'length') return current.length;
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return current[Number(key)];
        },
      }));
      collections.set(name, collection);
    }
    return collection;
  }
  return new Proxy(Object.create(prototype), {
    get(target, name, receiver) {
      if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
      const items = matches(name);
      return items.length ? value(name, items) : undefined;
    },
    has: (target, name) => Reflect.has(target, name) || matches(name).length > 0,
    getOwnPropertyDescriptor(target, name) {
      const own = Reflect.getOwnPropertyDescriptor(target, name);
      if (own || Reflect.has(target, name)) return own;
      const items = matches(name);
      return items.length ? {value:value(name, items), writable:true, enumerable:true, configurable:true} : undefined;
    },
  });
}

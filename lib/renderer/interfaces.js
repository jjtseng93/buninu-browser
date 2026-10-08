/**
 * Web IDL interface objects for the engine's singleton platform objects
 * (navigator, screen, performance...).
 *
 * In a browser these objects have no own properties: attributes are
 * accessors and operations are methods on the interface prototype
 * (Navigator.prototype.userAgent is a getter), each throwing
 * "Illegal invocation" for a receiver that is not a platform object of that
 * interface, and Object.prototype.toString reads the interface name from
 * Symbol.toStringTag. The interface object itself throws when called or
 * constructed. Pages and integrity checks inspect exactly this shape.
 */

/**
 * @param {string} name interface name
 * @param {object} template members as an object literal: accessors stay
 *   accessors, functions become operations, other values read-only attributes
 * @param {{ parent?: object | null, base?: (prototype: object) => object }} [options]
 *   `parent` is the prototype's prototype; `base` makes an instance with the
 *   given prototype (an event target's constructor, for one)
 * Accessors and operations run with `this` set to the instance's slots
 * object (the template itself unless `create` was given one), so a template
 * may read its other members, or per-instance data, through `this`.
 *
 * @returns {{ Interface: Function, prototype: object, instance: object, create: (slots?: object) => object }}
 */
export function platformObject(name, template, { parent = Object.prototype, base = (prototype) => Object.create(prototype) } = {}) {
  const instances = new WeakMap();
  const check = (self) => {
    const slots = instances.get(self);
    if (!slots) throw new TypeError("Illegal invocation");
    return slots;
  };
  // An object literal method has no prototype and is not a constructor,
  // as built-in operations and accessors are.
  // Interface objects are constructors that refuse to construct.
  const Interface = { [name]: function () { throw new TypeError("Illegal constructor"); } }[name];
  const prototype = Object.create(parent);
  for (const key of Reflect.ownKeys(template)) {
    const descriptor = Object.getOwnPropertyDescriptor(template, key);
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set) {
      const { get, set } = descriptor;
      const member = {};
      Object.defineProperty(member, key, {
        get: get ? accessor({ get [key]() { return get.call(check(this)); } }, key).get : undefined,
        set: set ? accessor({ set [key](value) { set.call(check(this), value); } }, key).set : undefined,
      });
      Object.defineProperty(prototype, key, { ...Object.getOwnPropertyDescriptor(member, key), enumerable: true, configurable: true });
    } else if (typeof descriptor.value === "function") {
      const operation = descriptor.value;
      const method = { [key](...args) { return Reflect.apply(operation, check(this), args); } }[key];
      Object.defineProperty(method, "length", { value: operation.length });
      Object.defineProperty(prototype, key, { value: method, writable: true, enumerable: true, configurable: true });
    } else {
      const { value } = descriptor;
      Object.defineProperty(prototype, key, {
        get: accessor({ get [key]() { check(this); return value; } }, key).get,
        enumerable: true,
        configurable: true,
      });
    }
  }
  Object.defineProperty(prototype, "constructor", { value: Interface, writable: true, configurable: true });
  Object.defineProperty(prototype, Symbol.toStringTag, { value: name, configurable: true });
  Object.defineProperty(Interface, "prototype", { value: prototype, writable: false, enumerable: false, configurable: false });
  const create = (slots = template) => {
    const object = base(prototype);
    instances.set(object, slots);
    return object;
  };
  return { Interface, prototype, instance: create(), create };
}

const accessor = (object, key) => Object.getOwnPropertyDescriptor(object, key);

/**
 * window.localStorage and sessionStorage (HTML §12.2.1): the methods on
 * Storage.prototype, and the stored items as each storage's own properties
 * (`localStorage.theme` reads an item; assigning one stores a string).
 *
 * @param {object} parent Object.prototype of the page
 * @returns {{ Storage: Function, prototype: object, create: (map: Map<string, string>) => object }}
 */
export function storageInterface(parent = Object.prototype) {
  const maps = new WeakMap();
  const mapOf = (self) => {
    const map = maps.get(self);
    if (!map) throw new TypeError("Illegal invocation");
    return map;
  };
  const Storage = { Storage: function () { throw new TypeError("Illegal constructor"); } }.Storage;
  const members = {
    get length() { return mapOf(this).size; },
    key(index) { return [...mapOf(this).keys()][Number(index)] ?? null; },
    getItem(key) { const map = mapOf(this); return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { mapOf(this).set(String(key), String(value)); },
    removeItem(key) { mapOf(this).delete(String(key)); },
    clear() { mapOf(this).clear(); },
  };
  const prototype = Object.create(parent);
  for (const key of Reflect.ownKeys(members)) {
    const descriptor = Object.getOwnPropertyDescriptor(members, key);
    if (!descriptor) continue;
    Object.defineProperty(prototype, key, { ...descriptor, enumerable: true, configurable: true });
  }
  Object.defineProperty(prototype, "constructor", { value: Storage, writable: true, configurable: true });
  Object.defineProperty(prototype, Symbol.toStringTag, { value: "Storage", configurable: true });
  Object.defineProperty(Storage, "prototype", { value: prototype });
  const create = (map) => {
    const target = Object.create(prototype);
    const named = (key) => typeof key === "string" && !(key in prototype);
    const proxy = new Proxy(target, {
      get(object, key) {
        if (named(key) && map.has(key)) return map.get(key);
        return Reflect.get(object, key, proxy);
      },
      set(object, key, value) {
        if (!named(key)) return Reflect.set(object, key, value, proxy);
        map.set(key, String(value));
        return true;
      },
      has(object, key) {
        return (named(key) && map.has(key)) || Reflect.has(object, key);
      },
      deleteProperty(object, key) {
        if (named(key)) map.delete(key);
        return Reflect.deleteProperty(object, key);
      },
      ownKeys(object) {
        return [...map.keys(), ...Reflect.ownKeys(object)];
      },
      getOwnPropertyDescriptor(object, key) {
        if (named(key) && map.has(key)) return { value: map.get(key), writable: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
      defineProperty(object, key, descriptor) {
        if (!named(key) || !("value" in descriptor)) return Reflect.defineProperty(object, key, descriptor);
        map.set(key, String(descriptor.value));
        return true;
      },
    });
    maps.set(proxy, map);
    return proxy;
  };
  return { Storage, prototype, create };
}

/** ECMAScript's own global properties: not enumerable on a browser's window. */
const LANGUAGE_GLOBALS = new Set(["globalThis", "Infinity", "NaN", "undefined", "eval", "isFinite", "isNaN",
  "parseFloat", "parseInt", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape"]);

/**
 * The Web IDL shape of a page's global object, applied before page script:
 *
 * - every interface prototype names its interface for Object.prototype.toString
 *   (`[object Window]`, `[object HTMLDivElement]`), and
 * - language globals and interface objects (constructors and namespaces,
 *   which are capitalized) are not enumerable, while the window's own
 *   attributes and operations (document, setTimeout, onload...) are.
 *
 * @param {object} global the page global
 * @param {object[]} intrinsicPrototypes prototypes that belong to the
 *   language (Object.prototype...), left without a tag
 */
export function applyGlobalShape(global, intrinsicPrototypes = []) {
  const skip = new Set(intrinsicPrototypes);
  for (const key of Reflect.ownKeys(global)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (!descriptor) continue;
    const value = descriptor.value;
    const isInterface = /^[A-Z]/.test(key) && (typeof value === "function" || (value && typeof value === "object"));
    if (typeof value === "function" && /^[A-Z]/.test(key) && value.prototype && typeof value.prototype === "object"
      && !skip.has(value.prototype) && !Object.hasOwn(value.prototype, Symbol.toStringTag)
      && Object.isExtensible(value.prototype)) {
      Object.defineProperty(value.prototype, Symbol.toStringTag, { value: key, configurable: true });
    }
    if ((isInterface || LANGUAGE_GLOBALS.has(key)) && descriptor.enumerable && descriptor.configurable) {
      Object.defineProperty(global, key, { ...descriptor, enumerable: false });
    }
  }
  const windowPrototype = Object.getPrototypeOf(global);
  if (windowPrototype && !Object.hasOwn(windowPrototype, Symbol.toStringTag) && Object.isExtensible(windowPrototype)) {
    Object.defineProperty(windowPrototype, Symbol.toStringTag, { value: "Window", configurable: true });
  }
}

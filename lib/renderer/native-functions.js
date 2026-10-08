/**
 * Web APIs implemented in JavaScript, presented the way a browser presents
 * its built-ins. Chromium's bindings are generated C++: each operation and
 * attribute accessor prints as "function name() { [native code] }", is named
 * after its IDL member, and accessors are named "get x" / "set x". Page
 * scripts (and integrity checks) read exactly these things.
 *
 * The patched SES bundle leaves its toString taming's marker on the host
 * global under a registered symbol; the first use here takes it and removes it.
 */
const MARKER_KEY = Symbol.for("ses.markVirtualizedNativeFunction");
let marker = null;

function markVirtualizedNative(fn) {
  if (!marker) {
    const found = globalThis[MARKER_KEY];
    if (typeof found !== "function") return;
    marker = found;
    delete globalThis[MARKER_KEY];
  }
  marker(fn);
}

function memberName(key) {
  return typeof key === "symbol" ? `[${key.description ?? ""}]` : key;
}

/** Marks `fn` as built-in, renaming it to `name` when its own name is different and still changeable. */
export function markNative(fn, name = undefined) {
  if (typeof fn !== "function") return fn;
  if (name !== undefined && fn.name !== name) {
    const descriptor = Object.getOwnPropertyDescriptor(fn, "name");
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(fn, "name", { value: name, configurable: true });
    }
  }
  markVirtualizedNative(fn);
  return fn;
}

/** Marks the own operations and accessors of `object` (not its prototypes). */
export function markNativeMembers(object) {
  for (const key of Reflect.ownKeys(object)) {
    if (key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) continue;
    const name = memberName(key);
    if (typeof descriptor.value === "function") markNative(descriptor.value, name);
    if (descriptor.get) markNative(descriptor.get, `get ${name}`);
    if (descriptor.set) markNative(descriptor.set, `set ${name}`);
  }
}

/**
 * Marks every host-implemented API reachable from a page global before page
 * script runs: global functions (with their prototypes and statics) and the
 * objects behind global properties, following prototype chains up to the
 * shared intrinsics, which are already native.
 */
export function markNativeApi(root, { stop = [Object.prototype, Function.prototype] } = {}) {
  const seen = new Set(stop);
  const visit = (object, depth) => {
    if (object === null || (typeof object !== "object" && typeof object !== "function") || seen.has(object)) return;
    seen.add(object);
    if (Array.isArray(object)) return;
    markNativeMembers(object);
    if (depth <= 0) return;
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) continue;
      if (!("value" in descriptor)) continue;
      const value = descriptor.value;
      if (typeof value === "function") {
        visit(value, depth - 1);
        if (value.prototype && typeof value.prototype === "object") visit(value.prototype, depth - 1);
      } else if (value && typeof value === "object") {
        visit(value, depth - 1);
      }
    }
    visit(Object.getPrototypeOf(object), depth);
  };
  for (const key of Reflect.ownKeys(root)) {
    const descriptor = Object.getOwnPropertyDescriptor(root, key);
    if (!descriptor) continue;
    if (descriptor.get) markNative(descriptor.get, `get ${memberName(key)}`);
    if (descriptor.set) markNative(descriptor.set, `set ${memberName(key)}`);
    const value = descriptor.value;
    if (typeof value === "function") {
      markNative(value, memberName(key));
      visit(value, 2);
      if (value.prototype && typeof value.prototype === "object") visit(value.prototype, 2);
    } else if (value && typeof value === "object" && value !== root) {
      visit(value, 2);
    }
  }
  visit(Object.getPrototypeOf(root), 2);
}

const TRANSFORM_KEY = Symbol.for("ses.setFunctionSourceTextTransform");

/**
 * Has Function.prototype.toString show the page's own source text for code
 * the engine rewrote before evaluating it (see restoreSourceText). The
 * patched SES bundle offers the setter once; later calls do nothing.
 *
 * @param {(text: string) => string} transform
 */
export function setFunctionSourceTextTransform(transform) {
  const setter = globalThis[TRANSFORM_KEY];
  if (typeof setter !== "function") return;
  delete globalThis[TRANSFORM_KEY];
  setter(transform);
}

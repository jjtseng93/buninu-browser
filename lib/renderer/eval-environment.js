// Sloppy direct eval can add var/function bindings to its caller. A private
// environment per invocation keeps those bindings out of the page global.
const targets = new WeakMap();
export function evalEnvironment(global, parent = null) {
  const bindings = Object.create(null);
  const fallback = parent ?? global;
  const proxy = new Proxy(bindings, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      if (key in fallback) return fallback[key];
      if (typeof key === 'symbol') return undefined;
      throw new ReferenceError(`${key} is not defined`);
    },
    has: (target, key) => Object.hasOwn(target, key) || key in fallback,
    set(target, key, value) {
      if (Object.hasOwn(target, key)) target[key] = value;
      else fallback[key] = value;
      return true;
    },
    deleteProperty(target, key) {return Object.hasOwn(target,key) ? delete target[key] : delete fallback[key];},
  });
  targets.set(proxy,bindings);
  return proxy;
}
export function declareEvalBinding(environment, name) {
  const target = targets.get(environment);
  if (target && !Object.hasOwn(target,name)) target[name] = undefined;
}

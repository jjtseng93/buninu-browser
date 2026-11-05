import {encodingString} from './encoding-string.js';

const NativePattern = globalThis.URLPattern;
const patterns = new WeakMap();
const wellFormed = String.prototype.toWellFormed;
const components = ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash'];
// Web IDL dictionaries read members in lexicographic order, once each.
const inputMembers = ['baseURL', 'hash', 'hostname', 'password', 'pathname', 'port', 'protocol', 'search', 'username'];
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const nativeDescriptors = typeof NativePattern === 'function'
  ? Object.getOwnPropertyDescriptors(NativePattern.prototype) : null;

// Each document/worker owns its public interface. Bun's parser and its private
// instances remain shared implementation details, never page-visible objects.
export function urlPatternInterface(global = () => globalThis) {
  if (!nativeDescriptors) return undefined;
  // Installed after the realm's intrinsics exist and before any author code.
  // Later assignments to window.TypeError/Object/Array must not affect IDL.
  const {TypeError:RealmTypeError, Object:RealmObject, Array:RealmArray} = global();
  const error = message => new RealmTypeError(message);
  const string = value => wellFormed.call(encodingString(value, (_, message) => error(message)));
  const input = value => {
    if (value != null && !object(value)) return string(value);
    const converted = Object.create(null);
    if (value != null) for (const key of inputMembers) {
      const member = value[key];
      if (member !== undefined) converted[key] = string(member);
    }
    return converted;
  };
  const options = value => {
    if (value != null && !object(value)) throw error('Options must be a dictionary');
    return {ignoreCase:Boolean(value?.ignoreCase)};
  };
  const native = operation => {
    try { return operation(); }
    catch (caught) {
      if (caught instanceof TypeError) throw error(caught.message);
      throw caught;
    }
  };
  const patternOf = value => {
    const pattern = patterns.get(value);
    if (!pattern) throw error('Illegal invocation');
    return pattern;
  };
  function URLPattern(value = {}, baseOrOptions = undefined, optionValue = undefined) {
    if (!new.target) throw error('URLPattern requires new');
    // The third argument selects the base-URL overload even when undefined.
    // With two arguments, objects/null/undefined select the options dictionary.
    const withBase = arguments.length >= 3 || (baseOrOptions != null && !object(baseOrOptions));
    value = input(value);
    let pattern;
    if (withBase) {
      const base = string(baseOrOptions);
      const settings = options(optionValue);
      pattern = native(() => new NativePattern(value, base, settings));
    } else {
      const settings = options(baseOrOptions);
      pattern = native(() => new NativePattern(value, settings));
    }
    patterns.set(this, pattern);
  }
  Object.defineProperty(URLPattern, 'prototype', {writable:false});
  for (const key of [...components, 'hasRegExpGroups']) {
    Object.defineProperty(URLPattern.prototype, key, {
      get() { return nativeDescriptors[key].get.call(patternOf(this)); },
      enumerable:true, configurable:true,
    });
  }
  // Results are Web IDL dictionaries/sequences, with objects local to the
  // interface's realm. All leaves here came from the parser, not author code.
  const result = value => {
    if (value === null || typeof value !== 'object') return value;
    const target = Array.isArray(value) ? new RealmArray() : new RealmObject();
    for (const key of Object.keys(value)) Object.defineProperty(target, key, {
      value:result(value[key]), writable:true, enumerable:true, configurable:true,
    });
    return target;
  };
  for (const name of ['test', 'exec']) {
    const method = {[name](value = {}, baseURL = undefined) {
      const pattern = patternOf(this);
      value = input(value);
      const args = baseURL === undefined ? [value] : [value, string(baseURL)];
      const returned = native(() => Reflect.apply(nativeDescriptors[name].value, pattern, args));
      return name === 'exec' ? result(returned) : returned;
    }}[name];
    Object.defineProperty(URLPattern.prototype, name, {value:method, writable:true, enumerable:true, configurable:true});
  }
  Object.defineProperty(URLPattern.prototype, Symbol.toStringTag, {value:'URLPattern', configurable:true});
  return URLPattern;
}

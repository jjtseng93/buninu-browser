import {encodingString} from './encoding-string.js';
import {types} from 'node:util';
const {isNativeError, isProxy} = types;
// Captured before lockdown. SES's override-taming accessors on these frozen
// intrinsic prototypes carry a data-only originalValue, which diagnostics can
// inspect without calling getters. Never trust that annotation on page objects.
const intrinsicErrorPrototypes = new Set([Error,EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError,AggregateError]
  .map(Constructor => Constructor.prototype));

// Keep page values on the page-side event wrapper, never in Happy DOM.
const slots = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

export function errorEventInterface(Event, global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  const unsignedLong = value => {
    if (object(value)) {
      const exotic = value[Symbol.toPrimitive];
      if (exotic != null) {
        if (typeof exotic !== 'function') throw error('TypeError', 'Invalid primitive converter');
        value = Reflect.apply(exotic, value, ['number']);
      } else {
        const original = value;
        for (const key of ['valueOf', 'toString']) {
          const method = original[key];
          if (typeof method === 'function') {
            value = Reflect.apply(method, original, []);
            if (!object(value)) break;
          }
        }
      }
    }
    if (object(value) || typeof value === 'symbol' || typeof value === 'bigint')
      throw error('TypeError', 'Error location must be a number');
    return Number(value) >>> 0;
  };
  function ErrorEvent(type, options = undefined) {
    if (!new.target || !arguments.length) throw error('TypeError', 'ErrorEvent requires new and an event type');
    type = encodingString(type, error);
    if (options != null && !object(options)) throw error('TypeError', 'Event options must be a dictionary');
    const init = {bubbles:Boolean(options?.bubbles), cancelable:Boolean(options?.cancelable), composed:Boolean(options?.composed)};
    // Web IDL dictionary conversion: base members, then sorted own members.
    const colno = options?.colno;
    const values = {colno:colno === undefined ? 0 : unsignedLong(colno), error:options?.error};
    const filename = options?.filename;
    values.filename = filename === undefined ? '' : encodingString(filename, error);
    const lineno = options?.lineno;
    values.lineno = lineno === undefined ? 0 : unsignedLong(lineno);
    const message = options?.message;
    values.message = message === undefined ? '' : encodingString(message, error);
    const event = new Event(type, init);
    const prototype = new.target.prototype;
    Object.setPrototypeOf(event, object(prototype) ? prototype : ErrorEvent.prototype);
    slots.set(event, values);
    return event;
  }
  ErrorEvent.prototype = Object.create(Event.prototype, {constructor:{value:ErrorEvent, writable:true, configurable:true}});
  Object.defineProperty(ErrorEvent, 'prototype', {writable:false});
  Object.setPrototypeOf(ErrorEvent, Event);
  for (const name of ['message', 'filename', 'lineno', 'colno', 'error']) {
    Object.defineProperty(ErrorEvent.prototype, name, {
      get() {
        const values = slots.get(this);
        if (!values) throw error('TypeError', 'Illegal invocation');
        return values[name];
      }, enumerable:true, configurable:true,
    });
  }
  Object.defineProperty(ErrorEvent.prototype, Symbol.toStringTag, {value:'ErrorEvent', configurable:true});
  return ErrorEvent;
}

// Reporting an exception must itself survive arbitrary thrown values, even
// objects whose message/name/string conversion throws. No privileged stack
// reader is used here: developer-only stacks must not become page capabilities.
export function exceptionMessage(error) {
  try {
    // Reporting does not perform JavaScript property gets or ToPrimitive on
    // arbitrary exceptions (HTML reportError). Even a Proxy's traps stay idle.
    if (!object(error)) return 'Uncaught ' + String(error);
    if (!isNativeError(error)) return 'Uncaught [object Object]';
    const name = errorDataProperty(error, 'name');
    const message = errorDataProperty(error, 'message');
    return 'Uncaught ' + (typeof name === 'string' ? name : 'Error')
      + (typeof message === 'string' && message ? ': ' + message : '');
  } catch { return 'Uncaught exception'; }
}

export function errorDataProperty(error, name) {
  if (!isNativeError(error)) return undefined;
  return errorDataDescriptor(error, name)?.value;
}

// undefined means absent; null means resolving the property would execute
// author code. In particular, never traverse a Proxy to inspect its prototype.
function errorDataDescriptor(error, name) {
  for (let target = error; target; target = Object.getPrototypeOf(target)) {
    if (isProxy(target)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if ('value' in descriptor) return descriptor;
      if ((name === 'name' || name === 'message') && intrinsicErrorPrototypes.has(target)
        && Object.isFrozen(target) && typeof descriptor.get === 'function' && !isProxy(descriptor.get)) {
        const original = Object.getOwnPropertyDescriptor(descriptor.get, 'originalValue');
        if (original && 'value' in original) return original;
      }
      return null;
    }
  }
}

export function canReadErrorStack(error) {
  if (!isNativeError(error)) return false;
  // Validate name/message before inspecting a potentially lazy stack. Stack
  // formatting can read them and coerce objects even through SES's reader.
  for (const name of ['name', 'message', 'stack']) {
    const descriptor = errorDataDescriptor(error, name);
    if (descriptor === null) return false;
    const value = descriptor?.value;
    if (value !== undefined && typeof value !== 'string') return false;
  }
  return true;
}

export function createErrorReporting({Event, realm, window, global, log}) {
  const ErrorEvent = errorEventInterface(Event, global);
  let reporting = false;
  const nested = [];
  function report(error, {filename = '', lineno = 0, colno = 0, muted = false} = {}) {
    // HTML's "in error reporting mode" flag prevents a throwing error handler
    // from recursively firing error forever. Nested errors still reach the
    // developer log, after the original exception has been handled/reported.
    if (reporting) { nested.push([error, filename]); return; }
    reporting = true;
    try {
      const event = new ErrorEvent('error', {cancelable:true,
        message:muted ? 'Script error.' : exceptionMessage(error),
        filename:muted ? '' : filename, lineno:muted ? 0 : lineno, colno:muted ? 0 : colno,
        error:muted ? null : error});
      realm.markTrusted(event);
      // Use the native target internally. Public dispatchEvent intentionally
      // clears isTrusted and may have been overridden by the page.
      const native = realm.unwrapEvent(event);
      window.dispatchEvent(native);
      if (!native.defaultPrevented) log(error, filename);
    } finally {
      reporting = false;
      for (const [reason, source] of nested.splice(0)) log(reason, source);
    }
  }
  function installOnError() {
    let handler = null, invoke = null, installed = false;
    const listener = native => {
      const event = realm.wrapEvent(native), fields = slots.get(event);
      // ErrorEvent on Window uses five arguments and *true* cancels. A plain
      // Event named error has normal one-argument/return-false semantics.
      const result = invoke(fields
        ? [fields.message, fields.filename, fields.lineno, fields.colno, fields.error] : [event]);
      if (result === (fields ? true : false)) native.preventDefault();
    };
    Object.defineProperty(global(), 'onerror', {
      configurable:true, enumerable:true,
      get() { return handler; },
      set(value) {
        handler = typeof value === 'function' ? value : null;
        const callback = args => realm.hooks.call(handler, global(), args);
        invoke = realm.hooks.captureCallback?.(callback) ?? callback;
        // Replacing a handler retains its listener's position in the list.
        if (handler && !installed) { window.addEventListener('error', listener); installed = true; }
        else if (!handler && installed) { window.removeEventListener('error', listener); installed = false; }
      },
    });
  }
  return {ErrorEvent, report, installOnError};
}

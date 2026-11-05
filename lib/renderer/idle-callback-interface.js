import {bindingNumber} from './bindings.js';

// Shared brands allow borrowing a method from a same-origin frame without
// changing the deadline's originating clock. Weak keys do not retain pages.
const deadlines = new WeakMap();
const windows = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

export function createIdleCallbackInterface({request, cancel}) {
  let pageGlobal, TypeErrorConstructor;
  const error = message => new TypeErrorConstructor(message);
  const conversionRealm = {hooks:{pageGlobal:() => ({TypeError:TypeErrorConstructor})}};
  const unsigned = value => bindingNumber(value, conversionRealm, 'idle callback argument') >>> 0;
  const receiver = value => {
    const record = windows.get(value == null ? pageGlobal : value);
    if (!record) throw error('Illegal invocation');
    return record;
  };
  const deadline = value => {
    const record = deadlines.get(value);
    if (!record) throw error('Illegal invocation');
    return record;
  };
  function IdleDeadline() { throw error('Illegal constructor'); }
  Object.defineProperty(IdleDeadline, 'prototype', {writable:false});
  Object.defineProperties(IdleDeadline.prototype, {
    timeRemaining:{value:({timeRemaining() {return deadline(this).timeRemaining();}}).timeRemaining, writable:true, enumerable:true, configurable:true},
    didTimeout:{get() {return deadline(this).didTimeout;}, enumerable:true, configurable:true},
    [Symbol.toStringTag]:{value:'IdleDeadline', configurable:true},
  });
  // Concise methods are not constructors, as required for Web IDL operations.
  const api = {
    IdleDeadline,
    requestIdleCallback(callback, options = undefined) {
      const target = receiver(this);
      if (typeof callback !== 'function') throw error('requestIdleCallback requires a callback');
      if (options != null && !object(options)) throw error('IdleRequestOptions must be a dictionary');
      const timeout = options?.timeout;
      return target.request(callback, timeout === undefined ? 0 : unsigned(timeout));
    },
    cancelIdleCallback(handle) {
      const target = receiver(this);
      if (!arguments.length) throw error('cancelIdleCallback requires a handle');
      target.cancel(unsigned(handle));
    },
  };
  return {
    api,
    initialize(global) {
      pageGlobal = global;
      TypeErrorConstructor = global.TypeError;
      // These objects are per page. Use that page's intrinsic prototypes,
      // including SES's mutable Function facade, without changing host ones.
      Object.setPrototypeOf(IdleDeadline.prototype, global.Object.prototype);
      for (const fn of [IdleDeadline, IdleDeadline.prototype.timeRemaining,
        Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'didTimeout').get,
        api.requestIdleCallback, api.cancelIdleCallback]) Object.setPrototypeOf(fn, global.Function.prototype);
      windows.set(global, {request, cancel});
    },
    wrap(record) {
      const instance = Object.create(IdleDeadline.prototype);
      deadlines.set(instance, record);
      return instance;
    },
  };
}

import {encodingString} from './encoding-string.js';

const slots = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

export function progressEventInterface(Event, global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  const number = value => {
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
      throw error('TypeError', 'Progress value must be a number');
    const result = Number(value);
    if (!Number.isFinite(result)) throw error('TypeError', 'Progress value must be finite');
    return result;
  };
  function ProgressEvent(type, options = undefined) {
    if (!new.target || !arguments.length) throw error('TypeError', 'ProgressEvent requires new and an event type');
    type = encodingString(type, error);
    if (options != null && !object(options)) throw error('TypeError', 'Event options must be a dictionary');
    // Inherited dictionary members precede ProgressEventInit members, each
    // group in lexicographic order. Read getters once and retain exceptions.
    const init = {bubbles:Boolean(options?.bubbles), cancelable:Boolean(options?.cancelable), composed:Boolean(options?.composed)};
    const lengthComputable = Boolean(options?.lengthComputable);
    const loaded = options?.loaded;
    const values = {lengthComputable, loaded:loaded === undefined ? 0 : number(loaded)};
    const total = options?.total;
    values.total = total === undefined ? 0 : number(total);
    const event = new Event(type, init);
    const prototype = new.target.prototype;
    Object.setPrototypeOf(event, object(prototype) ? prototype : ProgressEvent.prototype);
    slots.set(event, values);
    return event;
  }
  ProgressEvent.prototype = Object.create(Event.prototype, {constructor:{value:ProgressEvent, writable:true, configurable:true}});
  Object.defineProperty(ProgressEvent, 'prototype', {writable:false});
  Object.setPrototypeOf(ProgressEvent, Event);
  for (const name of ['lengthComputable', 'loaded', 'total']) {
    Object.defineProperty(ProgressEvent.prototype, name, {
      get() {
        const values = slots.get(this);
        if (!values) throw error('TypeError', 'Illegal invocation');
        return values[name];
      }, enumerable:true, configurable:true,
    });
  }
  Object.defineProperty(ProgressEvent.prototype, Symbol.toStringTag, {value:'ProgressEvent', configurable:true});
  return ProgressEvent;
}

import NativeHashChangeEvent from '../../vendor/happy-dom/packages/happy-dom/src/event/events/HashChangeEvent.ts';
import {encodingString} from './encoding-string.js';
import {isWindow} from './window-brand.js';
import {nodeListInterface} from './node-list.js';

// Slots belong to the underlying event, so dispatch and same-agent rewrapping
// retain both the interface brand and its values without exposing native DOM.
const events = new WeakMap();
const records = new WeakMap();
const touchLists = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
export const supplementalEventName = native => events.get(native)?.name;

export function supplementalEventInterfaces({realm, Event, UIEvent, unwrap, initialize,
  initializeUI, global = () => globalThis, secure = false, storageBrand, targetBrand}) {
  const error = (name, message) => new (global()[name])(message);
  const string = value => encodingString(value, error);
  const usv = value => string(value).toWellFormed();
  const nullableString = value => value == null ? null : string(value);
  const dictionary = value => {
    if (value != null && !object(value)) throw error('TypeError', 'Expected a dictionary');
    return value;
  };
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
      throw error('TypeError', 'Expected a number');
    return Number(value);
  };
  const finite = value => {
    const converted = number(value);
    if (!Number.isFinite(converted)) throw error('TypeError', 'Expected a finite number');
    return converted;
  };
  const float = value => {
    const converted = Math.fround(finite(value));
    if (!Number.isFinite(converted)) throw error('TypeError', 'Value exceeds the float range');
    return converted;
  };
  const nullableDouble = value => value == null ? null : finite(value);
  const view = value => {
    if (value != null && !isWindow(value)) throw error('TypeError', 'view must be a Window or null');
    return value ?? null;
  };
  const storage = value => {
    if (value != null && !storageBrand?.(value)) throw error('TypeError', 'storageArea must be a Storage or null');
    return value ?? null;
  };
  const baseInit = options => ({bubbles:Boolean(options?.bubbles),
    cancelable:Boolean(options?.cancelable), composed:Boolean(options?.composed)});
  const uiInit = options => {
    const init = baseInit(options), detail = options?.detail;
    init.detail = detail === undefined ? 0 : number(detail) | 0;
    init.view = view(options?.view);
    const which = options?.which;
    init.which = which === undefined ? 0 : number(which) >>> 0;
    return init;
  };
  const eventOf = (self, name) => {
    const native = unwrap(self);
    let state = native && events.get(native);
    // Happy DOM also creates these during ordinary fragment navigation.
    // Only copy its primitive URLs; never return a native object to a page.
    if (!state && native instanceof NativeHashChangeEvent) {
      state = {name:'HashChangeEvent', values:{oldURL:usv(native.oldURL), newURL:usv(native.newURL)}};
      events.set(native, state);
    }
    if (!state || state.name !== name) throw error('TypeError', 'Illegal invocation');
    return state.values;
  };
  const recordOf = (self, name) => {
    const state = records.get(self);
    if (!state || state.name !== name) throw error('TypeError', 'Illegal invocation');
    return state.values;
  };
  const prototype = (Constructor, name, parent) => {
    Object.setPrototypeOf(Constructor.prototype, parent);
    Object.defineProperties(Constructor.prototype, {
      constructor:{value:Constructor, writable:true, configurable:true},
      [Symbol.toStringTag]:{value:name, configurable:true},
    });
    Object.defineProperty(Constructor, 'prototype', {writable:false});
  };
  const getters = (Constructor, names, read) => {
    for (const name of names) Object.defineProperty(Constructor.prototype, name, {
      get: Object.getOwnPropertyDescriptor({get [name]() {return read(this)[name];}}, name).get,
      enumerable:true, configurable:true,
    });
  };
  const operation = (Constructor, name, method) => Object.defineProperty(Constructor.prototype, name,
    {value:method, writable:true, enumerable:true, configurable:true});
  const constructors = {}, factories = new Map();
  const defineEvent = (name, Base, convert, fields, {illegal = false} = {}) => {
    // Derived constructors avoid an implicit unused allocation. Read the target
    // prototype exactly once, before IDL argument conversion like native DOM
    // constructors (including when arguments or the constructor are invalid).
    const Constructor = new Proxy({[name]:class extends Base {
      constructor(type, options = undefined) {
        const requestedPrototype = new.target.prototype;
        if (illegal || !arguments.length)
          throw error('TypeError', illegal ? 'Illegal constructor' : `${name} requires an event type`);
        type = string(type);
        dictionary(options);
        return make(type, options, requestedPrototype);
      }
    }}[name], {apply() {throw error('TypeError', `${name} requires new`);}});
    if (illegal) Object.defineProperty(Constructor, 'length', {value:0});
    Object.setPrototypeOf(Constructor, Base);
    prototype(Constructor, name, Base.prototype);
    const make = (type, options, requestedPrototype = Constructor.prototype) => {
      // Inherited dictionary members precede the derived dictionary members;
      // every getter is read once, in Web IDL's lexicographic order.
      const init = Base === UIEvent ? uiInit(options) : baseInit(options);
      const values = convert(options);
      const event = new Base(type, init);
      if (Base === UIEvent) initializeUI(event, {type, ...init});
      events.set(unwrap(event), {name, values});
      Object.setPrototypeOf(event, object(requestedPrototype) ? requestedPrototype : Constructor.prototype);
      return event;
    };
    getters(Constructor, fields, self => eventOf(self, name));
    constructors[name] = Constructor;
    factories.set(name.toLowerCase(), () => make('', undefined));
    realm.eventPrototypes.set(name, Constructor.prototype);
    return Constructor;
  };

  const BeforeUnloadEvent = defineEvent('BeforeUnloadEvent', Event,
    () => ({returnValue:''}), [], {illegal:true});
  Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
    get() {return eventOf(this, 'BeforeUnloadEvent').returnValue;},
    set(value) {const values = eventOf(this, 'BeforeUnloadEvent'); values.returnValue = string(value);},
    enumerable:true, configurable:true,
  });
  const CompositionEvent = defineEvent('CompositionEvent', UIEvent, options => {
    const data = options?.data;
    return {data:data === undefined ? '' : usv(data)};
  }, ['data']);
  const TextEvent = defineEvent('TextEvent', UIEvent, () => ({data:''}), ['data'], {illegal:true});
  for (const [Constructor, name, defaultData, convert] of [
    // Current UI Events specifies an empty CompositionEvent default (and a
    // USVString attribute); the older Chromium IDL uses "undefined"/DOMString.
    [CompositionEvent, 'CompositionEvent', '', usv], [TextEvent, 'TextEvent', 'undefined', string],
  ]) {
    const methodName = name === 'TextEvent' ? 'initTextEvent' : 'initCompositionEvent';
    const method = {[methodName](type, bubbles = false, cancelable = false, window = null, data = defaultData) {
      const values = eventOf(this, name);
      if (!arguments.length) throw error('TypeError', `${methodName} requires a type`);
      type = string(type); window = view(window); data = convert(data);
      if (initializeUI(this, {type, bubbles:Boolean(bubbles), cancelable:Boolean(cancelable), view:window, detail:0}))
        values.data = data;
    }}[methodName];
    operation(Constructor, methodName, method);
  }
  defineEvent('HashChangeEvent', Event, options => {
    const newURL = options?.newURL, convertedNewURL = newURL === undefined ? '' : usv(newURL);
    const oldURL = options?.oldURL;
    return {newURL:convertedNewURL, oldURL:oldURL === undefined ? '' : usv(oldURL)};
  }, ['oldURL', 'newURL']);
  const StorageEvent = defineEvent('StorageEvent', Event, options => {
    const key = nullableString(options?.key), newValue = nullableString(options?.newValue),
      oldValue = nullableString(options?.oldValue), storageArea = storage(options?.storageArea), url = options?.url;
    return {key, newValue, oldValue, storageArea, url:url === undefined ? '' : usv(url)};
  }, ['key', 'oldValue', 'newValue', 'url', 'storageArea']);
  operation(StorageEvent, 'initStorageEvent', {
    initStorageEvent(type, bubbles = false, cancelable = false, key = null, oldValue = null,
      newValue = null, url = '', storageArea = null) {
      const values = eventOf(this, 'StorageEvent');
      if (!arguments.length) throw error('TypeError', 'initStorageEvent requires a type');
      type = string(type); key = nullableString(key); oldValue = nullableString(oldValue);
      newValue = nullableString(newValue); url = usv(url); storageArea = storage(storageArea);
      if (initialize(this, {type, bubbles:Boolean(bubbles), cancelable:Boolean(cancelable)}))
        Object.assign(values, {key, oldValue, newValue, url, storageArea});
    },
  }.initStorageEvent);

  if (secure) {
    const defineRecord = (name, fields) => {
      const Constructor = {[name]:function () {throw error('TypeError', 'Illegal constructor');}}[name];
      prototype(Constructor, name, Object.prototype);
      getters(Constructor, fields, self => recordOf(self, name));
      constructors[name] = Constructor;
      return options => {
        if (options === undefined) return null;
        dictionary(options);
        const values = {};
        for (const field of fields) values[field] = nullableDouble(options?.[field]);
        const record = Object.create(Constructor.prototype);
        records.set(record, {name, values});
        return record;
      };
    };
    const acceleration = defineRecord('DeviceMotionEventAcceleration', ['x', 'y', 'z']);
    const rotation = defineRecord('DeviceMotionEventRotationRate', ['alpha', 'beta', 'gamma']);
    defineEvent('DeviceOrientationEvent', Event, options => ({absolute:Boolean(options?.absolute),
      alpha:nullableDouble(options?.alpha), beta:nullableDouble(options?.beta), gamma:nullableDouble(options?.gamma)}),
    ['alpha', 'beta', 'gamma', 'absolute']);
    defineEvent('DeviceMotionEvent', Event, options => {
      const first = acceleration(options?.acceleration), gravity = acceleration(options?.accelerationIncludingGravity);
      const interval = options?.interval, convertedInterval = interval === undefined ? 0 : finite(interval);
      return {acceleration:first, accelerationIncludingGravity:gravity, interval:convertedInterval,
        rotationRate:rotation(options?.rotationRate)};
    }, ['acceleration', 'accelerationIncludingGravity', 'rotationRate', 'interval']);
  }

  const touchFields = ['altitudeAngle', 'azimuthAngle', 'clientX', 'clientY', 'force', 'identifier',
    'pageX', 'pageY', 'radiusX', 'radiusY', 'rotationAngle', 'screenX', 'screenY', 'target', 'touchType'];
  const touchFloats = new Set(['force', 'radiusX', 'radiusY', 'rotationAngle']);
  const Touch = new Proxy(class Touch extends Object { constructor(options) {
    const requestedPrototype = new.target.prototype;
    if (!arguments.length) throw error('TypeError', 'Touch requires an initializer');
    dictionary(options);
    const values = {};
    for (const key of touchFields) {
      const value = options?.[key];
      if (key === 'identifier') {
        if (value === undefined) throw error('TypeError', 'Touch identifier is required');
        values[key] = number(value) | 0;
      } else if (key === 'target') {
        if (!targetBrand?.(value)) throw error('TypeError', 'Touch target must be an EventTarget');
        values[key] = value;
      } else if (key === 'touchType') {
        const type = value === undefined ? 'direct' : string(value);
        if (type !== 'direct' && type !== 'stylus') throw error('TypeError', 'Invalid touch type');
        values[key] = type;
      } else values[key] = value === undefined ? 0 : touchFloats.has(key) ? float(value) : finite(value);
    }
    const result = Object.create(object(requestedPrototype) ? requestedPrototype : Touch.prototype);
    records.set(result, {name:'Touch', values});
    return result;
  }}, {apply() {throw error('TypeError', 'Touch requires new');}});
  Object.setPrototypeOf(Touch, Function.prototype);
  prototype(Touch, 'Touch', Object.prototype);
  getters(Touch, touchFields, self => recordOf(self, 'Touch'));
  function TouchList() {throw error('TypeError', 'Illegal constructor');}
  prototype(TouchList, 'TouchList', Object.prototype);
  const listOf = self => {
    const values = touchLists.get(self);
    if (!values) throw error('TypeError', 'Illegal invocation');
    return values;
  };
  Object.defineProperty(TouchList.prototype, 'length', {get() {return listOf(this).length;}, enumerable:true, configurable:true});
  operation(TouchList, 'item', {item(index) {
    const values = listOf(this);
    if (!arguments.length) throw error('TypeError', 'item requires an index');
    return values[number(index) >>> 0] ?? null;
  }}.item);
  Object.defineProperty(TouchList.prototype, Symbol.iterator, {
    value:Array.prototype.values, writable:true, configurable:true,
  });
  // TouchList has legacy indexed properties, not writable Array elements.
  const indexed = nodeListInterface(global);
  const list = value => {
    const values = [];
    if (value !== undefined) {
      if (!object(value)) throw error('TypeError', 'Expected a sequence of Touch objects');
      const iterator = value[Symbol.iterator];
      if (typeof iterator !== 'function') throw error('TypeError', 'Touch sequence is not iterable');
      const iteratorObject = Reflect.apply(iterator, value, []);
      if (!object(iteratorObject)) throw error('TypeError', 'Iterator must return an object');
      const next = iteratorObject.next;
      if (typeof next !== 'function') throw error('TypeError', 'Iterator next must be callable');
      while (true) {
        const result = Reflect.apply(next, iteratorObject, []);
        if (!object(result)) throw error('TypeError', 'Iterator result must be an object');
        if (result.done) break;
        const touch = result.value;
        try {recordOf(touch, 'Touch');}
        catch (failure) {
          // IteratorClose must preserve the original conversion exception,
          // including if the author's return getter or method also throws.
          try {
            const close = iteratorObject.return;
            if (typeof close === 'function') Reflect.apply(close, iteratorObject, []);
          } catch {}
          throw failure;
        }
        values.push(touch);
      }
    }
    const result = indexed.create(values, value => value, {static:true, prototype:TouchList.prototype});
    touchLists.set(result, values);
    return result;
  };
  const modifiers = {Alt:'altKey', Control:'ctrlKey', Meta:'metaKey', AltGraph:'modifierAltGraph',
    CapsLock:'modifierCapsLock', Fn:'modifierFn', FnLock:'modifierFnLock', Hyper:'modifierHyper',
    NumLock:'modifierNumLock', ScrollLock:'modifierScrollLock', Super:'modifierSuper',
    Symbol:'modifierSymbol', SymbolLock:'modifierSymbolLock', Shift:'shiftKey'};
  const modifierFields = Object.values(modifiers).sort();
  const TouchEvent = defineEvent('TouchEvent', UIEvent, options => {
    const values = {};
    for (const key of modifierFields) values[key] = Boolean(options?.[key]);
    for (const key of ['changedTouches', 'targetTouches', 'touches']) values[key] = list(options?.[key]);
    return values;
  }, ['touches', 'targetTouches', 'changedTouches', 'altKey', 'metaKey', 'ctrlKey', 'shiftKey']);
  operation(TouchEvent, 'getModifierState', {getModifierState(key) {
    const values = eventOf(this, 'TouchEvent');
    if (!arguments.length) throw error('TypeError', 'getModifierState requires a key');
    const field = modifiers[string(key)];
    return typeof field === 'string' && values[field] === true;
  }}.getModifierState);
  constructors.Touch = Touch;
  constructors.TouchList = TouchList;
  return {constructors, create:name => factories.get(name.toLowerCase())?.() ?? null};
}

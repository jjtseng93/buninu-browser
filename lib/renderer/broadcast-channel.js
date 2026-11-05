import {encodingString} from './encoding-string.js';

// Bun supplies the structured-clone transport. Names are scoped by browser
// origin; the native channels and their event objects never reach page code.
const NativeBroadcastChannel = globalThis.BroadcastChannel;
const states = new WeakMap();

export function createBroadcastChannels({ origin, eventTargets, realm, runTask, DOMException }) {
  const {EventTarget, dispatchTrusted, defineHandler} = eventTargets;
  const invalid = message => new (realm.inputValueIntrinsics?.TypeError ?? TypeError)(message);
  // Renderer workers have separate module state but share Bun's channel
  // transport, so a counter would collide for unrelated opaque documents.
  const scope = origin === "null" ? `opaque:${crypto.randomUUID()}` : origin;
  const live = new Set();
  const context = {disposed:false, live, handlers:{}};
  const stateOf = object => {
    const state = states.get(object);
    if (!state) throw invalid("Illegal invocation");
    return state;
  };
  function BroadcastChannel(name) {
    if (!new.target) throw invalid("Constructor BroadcastChannel requires 'new'");
    if (!arguments.length) throw invalid("BroadcastChannel requires a name");
    const self = Reflect.construct(EventTarget, [], new.target);
    const channelName = encodingString(name, (_name, message) => invalid(message));
    // A saved constructor from a detached frame still constructs an inert
    // channel. Do not reopen native resources after its realm was disposed.
    const native = context.disposed ? null : new NativeBroadcastChannel(JSON.stringify([scope, channelName]));
    const state = { native, name: channelName, closed: false, context };
    states.set(self, state);
    if (!native) return self;
    live.add(state);
    for (const type of ["message", "messageerror"]) {
      native.addEventListener(type, incoming => {
        if (context.disposed || state.closed) return;
        runTask(() => {
          if (context.disposed || state.closed) return;
          const event = realm.messageEvent(type, { data: realm.exposeClonedData?.(incoming.data) ?? incoming.data, origin });
          // Public dispatchEvent deliberately clears isTrusted. Delivery is
          // internal, just like XHR, and must not call page-overridden methods.
          dispatchTrusted(self, event);
        });
      });
    }
    return self;
  }
  BroadcastChannel.prototype = Object.create(EventTarget.prototype, {
    constructor: { value: BroadcastChannel, writable: true, configurable: true },
    name: { get() { return stateOf(this).name; }, enumerable: true, configurable: true },
    postMessage: { value(message) {
      const state = stateOf(this);
      if (!arguments.length) throw invalid("postMessage requires a message");
      // HTML checks messaging eligibility before the closed flag or cloning.
      // In particular, detached-frame channels silently ignore even an
      // uncloneable value, but Web IDL argument checks still run first.
      if (state.context.disposed) return;
      if (state.closed) throw new DOMException("The channel is closed", "InvalidStateError");
      // The page exposes Bun's DOMException. Native clone errors already have
      // the correct brand; author getter exceptions must retain their identity.
      state.native.postMessage(message);
    }, writable: true, enumerable: true, configurable: true },
    close: { value() {
      const state = stateOf(this);
      if (state.closed) return;
      state.closed = true;
      state.native?.close();
      state.native = null;
      state.context.live.delete(state);
    }, writable: true, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: "BroadcastChannel", configurable: true },
  });
  for (const type of ["message", "messageerror"]) {
    // Replacing an event handler preserves its position among listeners.
    defineHandler(BroadcastChannel.prototype, type);
    const descriptor = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, `on${type}`);
    context.handlers[type] = descriptor;
    Object.defineProperty(BroadcastChannel.prototype, `on${type}`, {
      ...descriptor,
      get() { return stateOf(this).context.handlers[type].get.call(this); },
      set(handler) { stateOf(this).context.handlers[type].set.call(this, handler); },
    });
  }
  return { BroadcastChannel, dispose() {
    context.disposed = true;
    for (const state of live) { state.native.close(); state.native = null; }
    live.clear();
  } };
}

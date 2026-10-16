// Bun supplies the structured-clone transport. Names are scoped by browser
// origin; the native channels and their event objects never reach page code.
const NativeBroadcastChannel = globalThis.BroadcastChannel;

export function createBroadcastChannels({ origin, EventTarget, realm, runTask, DOMException }) {
  // Renderer workers have separate module state but share Bun's channel
  // transport, so a counter would collide for unrelated opaque documents.
  const scope = origin === "null" ? `opaque:${crypto.randomUUID()}` : origin;
  const states = new WeakMap();
  const live = new Set();
  let disposed = false;
  const stateOf = object => {
    const state = states.get(object);
    if (!state) throw new TypeError("Illegal invocation");
    return state;
  };
  function BroadcastChannel(name) {
    if (!new.target) throw new TypeError("Constructor BroadcastChannel requires 'new'");
    if (!arguments.length) throw new TypeError("BroadcastChannel requires a name");
    if (disposed) throw new DOMException("The document is no longer active", "InvalidStateError");
    const self = Reflect.construct(EventTarget, [], new.target);
    const channelName = String(name);
    const native = new NativeBroadcastChannel(JSON.stringify([scope, channelName]));
    const state = { native, name: channelName, closed: false, handlers: new Map() };
    states.set(self, state);
    live.add(state);
    for (const type of ["message", "messageerror"]) {
      native.addEventListener(type, incoming => {
        if (disposed || state.closed) return;
        runTask(() => {
          const event = realm.messageEvent(type, { data: incoming.data, origin });
          realm.markTrusted(event);
          EventTarget.prototype.dispatchEvent.call(self, event);
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
      if (state.closed) throw new DOMException("The channel is closed", "InvalidStateError");
      if (!arguments.length) throw new TypeError("postMessage requires a message");
      try { state.native.postMessage(message); }
      catch (error) { throw new DOMException(String(error.message ?? error), error.name === "DataCloneError" ? "DataCloneError" : "InvalidStateError"); }
    }, writable: true, enumerable: true, configurable: true },
    close: { value() {
      const state = stateOf(this);
      if (state.closed) return;
      state.closed = true;
      state.native.close();
      live.delete(state);
    }, writable: true, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: "BroadcastChannel", configurable: true },
  });
  for (const type of ["message", "messageerror"]) Object.defineProperty(BroadcastChannel.prototype, `on${type}`, {
    get() { return stateOf(this).handlers.get(type) ?? null; },
    set(handler) {
      const state = stateOf(this);
      const previous = state.handlers.get(type);
      if (previous) EventTarget.prototype.removeEventListener.call(this, type, previous);
      state.handlers.delete(type);
      if (typeof handler === "function") {
        state.handlers.set(type, handler);
        EventTarget.prototype.addEventListener.call(this, type, handler);
      }
    }, enumerable: true, configurable: true,
  });
  return { BroadcastChannel, dispose() {
    disposed = true;
    for (const state of live) { state.closed = true; state.native.close(); }
    live.clear();
  } };
}

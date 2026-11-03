// Document activation is private engine state. No timer or page-writable flag.
const documents = new WeakMap();
const TRANSIENT_LIFETIME = 5000;

// Match Chromium's keyboard activation: modifier-only presses and Escape
// do not establish user intent (keyboard_event_manager.cc).
const MODIFIERS = new Set(['Alt','AltGraph','Control','Shift','Meta','CapsLock','NumLock','ScrollLock','Fn','FnLock','Symbol','SymbolLock','Hyper','Super']);
function triggeringInput(event) {
  return event.type === 'keydown' && event.key !== 'Escape' && !MODIFIERS.has(event.key)
    || event.type === 'mousedown' || event.type === 'touchend'
    || event.type === 'pointerdown' && event.pointerType === 'mouse'
    || event.type === 'pointerup' && event.pointerType !== 'mouse';
}

function tree(root) {
  const seen = new Set(), pending = root ? [root] : [];
  while (pending.length) {
    const handle = pending.pop();
    if (seen.has(handle) || handle.closed()) continue;
    seen.add(handle);
    pending.push(...handle.children());
  }
  return seen;
}

/** Notify only from the engine's trusted input path, never dispatchEvent(). */
export function createUserActivation({ now, self = null }) {
  let seen = false, until = -Infinity, disposed = false;
  const state = {
    get hasBeenActive() { return seen; },
    get isActive() { return now() < until; },
    activate() {
      if (disposed) return;
      seen = true;
      until = now() + TRANSIENT_LIFETIME;
    },
    notify(event) {
      if (disposed || !triggeringInput(event)) return;
      if (!self) { state.activate(); return; }
      // HTML activation notifies ancestors and same-origin windows in the
      // frame tree. Serialized opaque origins must not compare as equal.
      const targets = new Set();
      for (let handle = self; handle && !targets.has(handle); handle = handle.parent()) targets.add(handle);
      const origin = self.origin();
      if (origin !== 'null') for (const handle of tree(self.top())) {
        if (handle.origin() === origin) targets.add(handle);
      }
      for (const handle of targets) documents.get(handle)?.activate();
    },
    consume() {
      const active = state.isActive;
      if (!active) return false;
      if (self) {
        // One gesture cannot be consumed repeatedly through sibling frames.
        for (const handle of tree(self.top())) documents.get(handle)?.clearTransient();
      } else state.clearTransient();
      return active;
    },
    clearTransient() { until = -Infinity; },
    dispose() {
      disposed = true;
      until = -Infinity;
      if (self && documents.get(self) === state) documents.delete(self);
    },
  };
  if (self) documents.set(self, state);
  return state;
}

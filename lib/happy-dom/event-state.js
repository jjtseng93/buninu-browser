import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import Event from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import EventTarget from '../../vendor/happy-dom/packages/happy-dom/src/event/EventTarget.ts';

// State belongs to the underlying event, not a document's wrapper. A captured
// event can be passed between same-agent realms and redispatched elsewhere.
const trusted = new WeakSet();
const uninitialized = new WeakSet();

export function markEventTrusted(event) { trusted.add(event); return event; }
export function isEventTrusted(event) { return trusted.has(event); }
export function markEventUninitialized(event) { uninitialized.add(event); return event; }
export function isEventDispatching(event) { return event[S.dispatching]; }
export function initializeEvent(event) {
  trusted.delete(event);
  uninitialized.delete(event);
  event[S.target] = null;
}
export function dispatchScriptEvent(target, event, prepare) {
  // Reject reentrant/uninitialized dispatch before clearing trust. Internal
  // native propagation still uses its existing dispatch flag and listener path.
  if (isEventDispatching(event) || uninitialized.has(event)) {
    throw new DOMException('The event is already dispatching or is not initialized', 'InvalidStateError');
  }
  trusted.delete(event);
  // A reused load event must take the normal dispatch path, not Happy DOM's
  // special listener-only path for an internally forwarded document load.
  event[S.target] = null;
  prepare?.();
  return target.dispatchEvent(event);
}

// Native input/reset/click events need the same dispatch cleanup as synthetic
// events. Only wrap the outer dispatch: native propagation recursively calls
// dispatchEvent for each target while its dispatch flag is set. In particular,
// cleanup must finish before an element runs post-dispatch activation steps.
const nativeDispatch = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function(event) {
  if (!(event instanceof Event) || event[S.dispatching]) return nativeDispatch.call(this, event);
  try {
    if (event[S.propagationStopped] || event[S.immediatePropagationStopped]) {
      event[S.target] = this[S.proxy] ?? this;
      return !(event.cancelable && event.defaultPrevented);
    }
    return nativeDispatch.call(this, event);
  } finally {
    event[S.dispatching] = false;
    event[S.eventPhase] = 0;
    event[S.currentTarget] = null;
    event[S.propagationStopped] = false;
    event[S.immediatePropagationStopped] = false;
  }
};

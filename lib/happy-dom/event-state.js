import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import Event from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import EventTarget from '../../vendor/happy-dom/packages/happy-dom/src/event/EventTarget.ts';
import {retargetShadowNode} from './shadow-tree.js';

// State belongs to the underlying event, not a document's wrapper. A captured
// event can be passed between same-agent realms and redispatched elsewhere.
const trusted = new WeakSet();
const uninitialized = new WeakSet();
const exposedTargets = new WeakMap();

export function exposedEventTarget(event, related = false) {
  const state = exposedTargets.get(event), index = related ? 1 : 0;
  if (!state) return related ? event.relatedTarget ?? null : event.target;
  if (!event[S.dispatching]) return state.after[index];
  return state.listeners.get(event.currentTarget)?.[index] ?? null;
}

// Snapshot the same parent path that native dispatch uses, before listeners
// can move/remove its nodes. Keep raw dispatch targets untouched. Ordinary DOM
// events need neither a path traversal nor a map; only shadow boundaries do.
function snapshotTargets(target, event) {
  const related = event.relatedTarget ?? null;
  const root = target.getRootNode?.();
  if (!root?.host && !related?.getRootNode?.().host) return null;
  const listeners = new Map();
  let last = target;
  for (let node = target; node;) {
    listeners.set(node, [retargetShadowNode(target, node), retargetShadowNode(related, node)]);
    last = node;
    node = node.parentNode ?? (node.nodeType === 11 && event.composed ? node.host
      : node.nodeType === 9 && event.type !== 'load' ? node.defaultView : null);
  }
  const after = listeners.get(last);
  // DOM dispatch clears targets if its final adjusted target still belongs to
  // a shadow tree (an uncomposed event never crossed that boundary).
  const clear = after.some(node => node?.getRootNode?.().host);
  return {listeners, after:clear ? [null, null] : after};
}

export function markEventTrusted(event) { trusted.add(event); return event; }
export function isEventTrusted(event) { return trusted.has(event); }
export function markEventUninitialized(event) { uninitialized.add(event); return event; }
export function isEventDispatching(event) { return event[S.dispatching]; }
export function initializeEvent(event) {
  trusted.delete(event);
  uninitialized.delete(event);
  event[S.target] = null;
  exposedTargets.delete(event);
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
  const exposed = snapshotTargets(this[S.proxy] ?? this, event);
  if (exposed) exposedTargets.set(event, exposed);
  else exposedTargets.delete(event);
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
    if (exposed) exposed.listeners = null;
  }
};

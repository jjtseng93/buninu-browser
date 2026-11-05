import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import HTMLSlotElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-slot-element/HTMLSlotElement.ts';
import Event from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {signalMutationSlotChange} from './mutation-notifications.js';
import {markEventTrusted} from './event-state.js';

// Only native assignment hooks signal a slot change. Author dispatchEvent()
// remains synchronous, including while a custom reaction is being invoked.
let nativeAssignment = 0;
const dispatchSlotEvent = HTMLSlotElement.prototype.dispatchEvent;
export function signalSlotChange(slot, event = new Event('slotchange', {bubbles:true})) {
  signalMutationSlotChange(slot, () => {
    if (!slot[S.window].closed) dispatchSlotEvent.call(slot, markEventTrusted(event));
  });
}

export function withoutNativeSlotChanges(callback) {
  const previous = nativeAssignment;
  nativeAssignment = 0;
  try { return callback(); }
  finally { nativeAssignment = previous; }
}

HTMLSlotElement.prototype.dispatchEvent = function(event) {
  if (!nativeAssignment || event.type !== 'slotchange' || event[S.dispatching])
    return dispatchSlotEvent.call(this, event);
  signalSlotChange(this, event);
  return true;
};

for (const [prototype, key, attribute] of [
  [Element.prototype, S.onSlotChange, null],
  [Element.prototype, S.onSetAttribute, 'slot'],
  [Element.prototype, S.onRemoveAttribute, 'slot'],
  [HTMLSlotElement.prototype, S.onSetAttribute, 'name'],
  [HTMLSlotElement.prototype, S.onRemoveAttribute, 'name'],
]) {
  const hook = prototype[key];
  prototype[key] = function(...args) {
    if (attribute && args[0]?.[S.name] !== attribute) return hook.apply(this, args);
    nativeAssignment++;
    try { return hook.apply(this, args); }
    finally { nativeAssignment--; }
  };
}

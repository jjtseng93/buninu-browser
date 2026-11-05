import './radio-groups.js';
import HTMLElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-element/HTMLElement.ts';
import HTMLElementUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-element/HTMLElementUtility.ts';
import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLButtonElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-button-element/HTMLButtonElement.ts';
import HTMLLabelElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-label-element/HTMLLabelElement.ts';
import FocusEvent from '../../vendor/happy-dom/packages/happy-dom/src/event/events/FocusEvent.ts';
import MouseEvent from '../../vendor/happy-dom/packages/happy-dom/src/event/events/MouseEvent.ts';
import Event from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { actuallyDisabled } from './form-disabled.js';
import { markEventTrusted } from './event-state.js';
import { activateSubmitOrReset } from './form-control-activation.js';

const focus = HTMLElementUtility.focus;
HTMLElementUtility.focus = function(element) {
  if (!actuallyDisabled(element)) return focus.call(this, element);
};
const click = HTMLElement.prototype.click;
HTMLElement.prototype.click = function(...args) {
  if (!actuallyDisabled(this)) return click.apply(this, args);
};

// Script dispatchEvent still delivers events on disabled controls. Disabled
// submit/reset/label controls have no activation; checkbox/radio legacy
// pre-activation is distinct and still applies (also confirmed in Chromium).
const dispatchButton = HTMLButtonElement.prototype.dispatchEvent;
HTMLButtonElement.prototype.dispatchEvent = function(event) {
  if (event[S.type] !== 'click' || event[S.eventPhase] !== 0 || !(event instanceof MouseEvent))
    return dispatchButton.call(this, event);
  const result = HTMLElement.prototype.dispatchEvent.call(this, event);
  if (event[S.type] === 'click' && !event.defaultPrevented) activateSubmitOrReset(this);
  return result;
};
HTMLLabelElement.prototype.dispatchEvent = function(event) {
  const result = HTMLElement.prototype.dispatchEvent.call(this, event);
  if (event[S.type] === 'click' && [2, 3].includes(event[S.eventPhase]) && event instanceof MouseEvent && !event.defaultPrevented) {
    const control = this.control;
    if (control && !actuallyDisabled(control) && event.target !== control)
      control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  return result;
};
const dispatchInput = HTMLInputElement.prototype.dispatchEvent;
HTMLInputElement.prototype.dispatchEvent = function(event) {
  if (event[S.type] !== 'click' || event[S.eventPhase] !== 0 || !(event instanceof MouseEvent))
    return dispatchInput.call(this, event);
  if (this.type === 'radio') return dispatchInput.call(this, event);
  const checked = this.type === 'checkbox' ? this.checked : null, indeterminate = this.indeterminate;
  if (checked !== null) {
    this.checked = !checked;
    this.indeterminate = false;
  }
  const result = HTMLElement.prototype.dispatchEvent.call(this, event);
  if (event[S.type] !== 'click') return result;
  if (event.defaultPrevented) {
    if (checked !== null) { this.checked = checked; this.indeterminate = indeterminate; }
  } else if ((this.type === 'checkbox' || this.type === 'radio' && !checked) && this.isConnected) {
    for (const type of ['input', 'change']) this.dispatchEvent(markEventTrusted(new Event(type, {
      bubbles: true, composed: type === 'input',
    })));
  } else activateSubmitOrReset(this);
  return result;
};

const blur = HTMLElementUtility.blur;
HTMLElementUtility.blur = function(element) {
  const target = element[S.proxy] ?? element, document = target[S.ownerDocument];
  if (!actuallyDisabled(target)) return blur.call(this, target);
  if (document[S.activeElement] !== target) return;
  const relatedTarget = document[S.nextActiveElement] ?? null;
  document[S.activeElement] = null;
  document[S.clearCache]();
  for (const type of ['blur', 'focusout']) target.dispatchEvent(markEventTrusted(new FocusEvent(type, {
    relatedTarget, bubbles: type === 'focusout', composed: true,
  })));
};

// Focus fixup runs during rendering updates, after attribute/tree mutations.
// Do not add a document observer or retain a list of controls per document.
export function fixDisabledFocus(document) {
  const active = document[S.activeElement];
  if (active && actuallyDisabled(active)) HTMLElementUtility.blur(active);
}

import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';
import HTMLInputElementValueSanitizer from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElementValueSanitizer.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import './input-value-constraints.js';
import { markEventTrusted } from './event-state.js';

// Shared by page bindings and the renderer's keyboard/clipboard paths. Native
// private selection fields cannot represent the required initial caret or
// queued events, so all selection operations use this single private state.
const states = new WeakMap();
const selectableTypes = new Set(['text', 'search', 'url', 'tel', 'password']);
const identity = element => element[S.proxy] ?? element;
const textarea = element => element.localName === 'textarea';
export const supportsTextSelection = element => textarea(element) || selectableTypes.has(element.type);
function state(element) {
  const key = identity(element);
  let value = states.get(key);
  if (!value) states.set(key, value = { start: 0, end: 0, direction: 'none', type: element.type });
  return value;
}
export function syncTextControlSelection(element) {
  const value = state(element), length = element.value.length;
  value.start = Math.min(value.start, length);
  value.end = Math.min(value.end, length);
  return value;
}
function invalidState(element, intrinsics) {
  if (!supportsTextSelection(element))
    throw new (intrinsics?.DOMException ?? element[S.window].DOMException)('This input type does not support text selection.', 'InvalidStateError');
}
function queueSelect(element) {
  const window = element[S.window];
  // Owner-window timers are cancelled when its document/window is disposed.
  window.setTimeout(() => element.dispatchEvent(markEventTrusted(new window.Event('select', { bubbles: true }))), 0);
}
function setRange(element, start, end, direction) {
  const value = syncTextControlSelection(element), length = element.value.length;
  end = Math.min(end ?? 0, length);
  start = Math.min(start ?? 0, end);
  direction = direction === 'forward' || direction === 'backward' ? direction : 'none';
  const changed = value.start !== start || value.end !== end || value.direction !== direction;
  value.start = start; value.end = end; value.direction = direction;
  if (changed) queueSelect(element);
}
export function textSelection(element, property) {
  return supportsTextSelection(element) ? syncTextControlSelection(element)[property] : null;
}
export function setTextSelection(element, property, value, intrinsics) {
  invalidState(element, intrinsics);
  const current = syncTextControlSelection(element);
  if (property === 'start') setRange(element, value, Math.max(value ?? 0, current.end), current.direction);
  else if (property === 'end') setRange(element, current.start, value, current.direction);
  else setRange(element, current.start, current.end, value);
}
export function setTextSelectionRange(element, start, end, direction, intrinsics) {
  invalidState(element, intrinsics);
  setRange(element, start, end, direction);
}
export function selectTextControl(element) {
  // Keep the platform's focus behavior used by select()+execCommand('copy').
  if (element.isConnected && !element.disabled && element.type !== 'hidden') element.focus();
  if (supportsTextSelection(element)) setRange(element, 0, element.value.length, 'none');
  else if (element.type === 'email' || element.type === 'number') {
    const value = state(element), length = element.value.length;
    if (value.start !== 0 || value.end !== length) { value.start = 0; value.end = length; queueSelect(element); }
  }
}
export function replaceTextSelection(element, replacement, start, end, mode = 'preserve', intrinsics) {
  invalidState(element, intrinsics);
  // The HTML algorithm sets dirty before checking the range. Unlike assigning
  // .value this does not itself change last-user-edit or selection state.
  if (element[S.value] === null) element[S.value] = element.value;
  const current = syncTextControlSelection(element);
  if (start === undefined) { start = current.start; end = current.end; }
  if (start > end) throw new (intrinsics?.DOMException ?? element[S.window].DOMException)('Start exceeds end.', 'IndexSizeError');
  const value = element.value, previous = { ...current };
  start = Math.min(start, value.length); end = Math.min(end, value.length);
  element.value = value.slice(0, start) + replacement + value.slice(end);
  // Relevant-value changes clamp the old range; the internal .value assignment
  // above must not manufacture a movement to the end or a spurious select.
  Object.assign(current, previous);
  syncTextControlSelection(element);
  const newEnd = start + replacement.length;
  let selectionStart = previous.start, selectionEnd = previous.end;
  if (mode === 'select') { selectionStart = start; selectionEnd = newEnd; }
  else if (mode === 'start') selectionStart = selectionEnd = start;
  else if (mode === 'end') selectionStart = selectionEnd = newEnd;
  else {
    const delta = replacement.length - (end - start);
    if (selectionStart > end) selectionStart += delta;
    else if (selectionStart > start) selectionStart = start;
    if (selectionEnd > end) selectionEnd += delta;
    else if (selectionEnd > start) selectionEnd = newEnd;
  }
  setRange(element, selectionStart, selectionEnd, 'none');
}

const unsigned = value => +value >>> 0;
const string = value => `${value}`;
for (const Type of [HTMLInputElement, HTMLTextAreaElement]) {
  const prototype = Type.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  Object.defineProperty(prototype, 'value', { ...descriptor, set(value) {
    // Convert before snapshot: a converter may reenter and set this control.
    value = value === null ? '' : string(value);
    const previous = this.value, selection = syncTextControlSelection(this);
    descriptor.set.call(this, value);
    if (previous !== this.value) {
      selection.start = selection.end = this.value.length;
      selection.direction = 'none';
    }
  } });
  for (const [name, property] of [['selectionStart', 'start'], ['selectionEnd', 'end'], ['selectionDirection', 'direction']]) {
    Object.defineProperty(prototype, name, { configurable: true, enumerable: true,
      get() { return textSelection(this, property); },
      set(value) { setTextSelection(this, property, property === 'direction' ? value == null ? '' : string(value) : unsigned(value)); },
    });
  }
  prototype.setSelectionRange = function(start, end, direction = 'none') {
    if (arguments.length < 2) throw new this[S.window].TypeError('setSelectionRange requires two arguments');
    setTextSelectionRange(this, unsigned(start), unsigned(end), string(direction));
  };
  prototype.setRangeText = function(replacement, ...args) {
    if (arguments.length === 0 || arguments.length === 2) throw new this[S.window].TypeError('Invalid setRangeText overload');
    replacement = string(replacement);
    let start, end, mode = 'preserve';
    if (args.length >= 2) {
      start = unsigned(args[0]); end = unsigned(args[1]);
      if (args[2] !== undefined) mode = string(args[2]);
      if (!['preserve', 'select', 'start', 'end'].includes(mode)) throw new this[S.window].TypeError('Invalid selection mode');
    }
    replaceTextSelection(this, replacement, start, end, mode);
  };
  prototype.select = function() { selectTextControl(this); };
}

HTMLTextAreaElement.prototype[S.resetSelection] = function() {
  if (this[S.value] === null) syncTextControlSelection(this);
};
for (const hook of [S.onSetAttribute, S.onRemoveAttribute]) {
  const original = HTMLInputElement.prototype[hook];
  HTMLInputElement.prototype[hook] = function(attribute, ...args) {
    const previous = states.get(identity(this));
    const oldType = previous?.type;
    const result = original.call(this, attribute, ...args);
    if (attribute.namespaceURI === null && attribute.localName === 'type') {
      if (this[S.value] !== null) this[S.value] = HTMLInputElementValueSanitizer.sanitize(this, this[S.value]);
      if (previous) {
        previous.type = this.type;
        if (!selectableTypes.has(oldType) && selectableTypes.has(this.type)) {
          previous.start = previous.end = 0; previous.direction = 'none';
        } else syncTextControlSelection(this);
      }
    } else if (previous && attribute.namespaceURI === null && attribute.localName === 'value') syncTextControlSelection(this);
    return result;
  };
}

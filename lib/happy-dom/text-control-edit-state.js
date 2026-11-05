import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';
import ValidityState from '../../vendor/happy-dom/packages/happy-dom/src/validity-state/ValidityState.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { textareaRawValue } from './textarea-values.js';

const edited = new WeakSet();
const textTypes = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const identity = element => element[S.proxy] ?? element;
const apiValue = value => String(value).replace(/\r\n?/g, '\n');

// Dirty value alone is insufficient: scripts can set an arbitrarily long or
// short value without causing these constraints to fail. This state belongs to
// the control, not to synthetic input events or the page-facing binding.
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#limiting-user-input-length:-the-maxlength-attribute
export function resetTextControlEditState(element) {
  edited.delete(identity(element));
}

export function setUserEditedValue(element, value) {
  element.value = value;
  edited.add(identity(element));
}

for (const Type of [HTMLInputElement, HTMLTextAreaElement]) {
  const prototype = Type.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  const textarea = Type === HTMLTextAreaElement;
  Object.defineProperty(prototype, 'value', { ...descriptor,
    get: textarea ? function() { return apiValue(textareaRawValue(this)); } : descriptor.get,
    set(value) {
    // Textarea's API value normalizes newlines. Its value setter leaves the
    // last-user-edit state alone if the API value did not actually change;
    // input's value setter explicitly clears that state even for the same value.
    const previous = textarea ? apiValue(textareaRawValue(this)) : null;
    if (textarea) value = value === null ? '' : `${value}`.replace(/\r\n?/g, '\n');
    descriptor.set.call(this, value);
    if (!textarea || previous !== apiValue(textareaRawValue(this))) resetTextControlEditState(this);
  } });
  const clone = prototype[S.cloneNode];
  prototype[S.cloneNode] = function(deep = false) {
    const copy = clone.call(this, deep);
    if (edited.has(identity(this))) edited.add(identity(copy));
    return copy;
  };
}

for (const [property, attribute] of [['tooLong', 'maxLength'], ['tooShort', 'minLength']]) {
  Object.defineProperty(ValidityState.prototype, property, {
    ...Object.getOwnPropertyDescriptor(ValidityState.prototype, property),
    get() {
      const element = this.element;
      const textarea = element.localName === 'textarea';
      if (!textarea && !(element.localName === 'input' && textTypes.has(element.type))) return false;
      if (element[S.value] === null || !edited.has(identity(element))) return false;
      const limit = element[attribute];
      if (limit < 0) return false;
      const length = (textarea ? apiValue(element.value) : element.value).length;
      return property === 'tooLong' ? length > limit : length > 0 && length < limit;
    },
  });
}

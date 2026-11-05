import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLInputElementValueSanitizer from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElementValueSanitizer.ts';
import ValidityState from '../../vendor/happy-dom/packages/happy-dom/src/validity-state/ValidityState.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { typedInputTypes, parseInputValue, parseNumberAttribute, inputStep, inputStepMismatch } from './input-value-types.js';
import { resetTextControlEditState } from './text-control-edit-state.js';

const sanitize = HTMLInputElementValueSanitizer.sanitize;
HTMLInputElementValueSanitizer.sanitize = function(input, value) {
  // Range has its own slider clamping/rounding algorithm; retain that path.
  return typedInputTypes.has(input.type) ? parseInputValue(input.type, value)?.text ?? '' : sanitize.call(this, input, value);
};

const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
Object.defineProperty(HTMLInputElement.prototype, 'value', { ...valueDescriptor, get() {
  if (!typedInputTypes.has(this.type)) return valueDescriptor.get.call(this);
  // Initial markup and reset/default values have not been assigned through
  // .value. Normalize their API value without making the control dirty.
  const source = this[S.value] === null ? this.getAttributeNS(null, 'value') ?? '' : this[S.value];
  return parseInputValue(this.type, source)?.text ?? '';
} });

const attributeChanged = HTMLInputElement.prototype[S.onSetAttribute];
HTMLInputElement.prototype[S.onSetAttribute] = function(attribute, ...args) {
  const result = attributeChanged.call(this, attribute, ...args);
  if (attribute.namespaceURI === null && attribute.localName === 'type' && this[S.value] !== null && typedInputTypes.has(this.type)) {
    // A dirty value sanitized on a type change cannot reappear when changing
    // back to text. Preserve dirtiness and last-user-edit if text is unchanged.
    const normalized = parseInputValue(this.type, this[S.value])?.text ?? '';
    if (normalized !== this[S.value]) {
      this[S.value] = normalized;
      resetTextControlEditState(this);
    }
  }
  return result;
};

function numberFor(type, source) {
  return type === 'number' || type === 'range' ? parseNumberAttribute(source) : parseInputValue(type, source)?.value ?? null;
}

function control(element) {
  if (element.localName !== 'input' || !(typedInputTypes.has(element.type) || element.type === 'range')) return null;
  const type = element.type, value = parseInputValue(type, element.value)?.value;
  if (value === undefined) return null;
  return { type, value, min: numberFor(type, element.getAttributeNS(null, 'min')), max: numberFor(type, element.getAttributeNS(null, 'max')) };
}

for (const property of ['rangeUnderflow', 'rangeOverflow']) {
  Object.defineProperty(ValidityState.prototype, property, {
    ...Object.getOwnPropertyDescriptor(ValidityState.prototype, property),
    get() {
      const state = control(this.element);
      if (!state) return false;
      const { type, value } = state;
      const min = state.min ?? (type === 'range' ? 0 : null), max = state.max ?? (type === 'range' ? 100 : null);
      // The time domain wraps at midnight. The gap between max and min lies
      // outside both ends; ordinary numeric/date min > max does not wrap.
      if (type === 'time' && min !== null && max !== null && min > max) return value > max && value < min;
      return property === 'rangeUnderflow' ? min !== null && value < min : max !== null && value > max;
    },
  });
}

Object.defineProperty(ValidityState.prototype, 'stepMismatch', {
  ...Object.getOwnPropertyDescriptor(ValidityState.prototype, 'stepMismatch'),
  get() {
    const element = this.element, state = control(element);
    if (!state) return false;
    const attribute = element.getAttributeNS(null, 'step');
    if (attribute !== null && /^[aA][nN][yY]$/.test(attribute)) return false;
    const defaults = inputStep(state.type), parsed = parseNumberAttribute(attribute);
    const step = parsed !== null && parsed > 0 ? parsed : defaults.default;
    const base = state.min ?? numberFor(state.type, element.getAttributeNS(null, 'value')) ?? defaults.base;
    return inputStepMismatch(state.value, base, step, defaults.scale);
  },
});

const badInput = Object.getOwnPropertyDescriptor(ValidityState.prototype, 'badInput');
Object.defineProperty(ValidityState.prototype, 'badInput', { ...badInput, get() {
  const element = this.element;
  // Exponent notation is a valid number. This does not synthesize the native
  // number editor's separate, not-yet-committed invalid-input buffer.
  if (element.localName === 'input' && ['number', 'range'].includes(element.type) && parseInputValue(element.type, element.value)) return false;
  return badInput.get.call(this);
} });

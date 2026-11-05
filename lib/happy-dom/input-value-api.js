import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { typedInputTypes, dateInputTypes, parseInputValue, inputDateTimestamp, serializeInputNumber, serializeInputDate } from './input-value-types.js';

const IntrinsicDate = Date;
const dateTime = Function.prototype.call.bind(Date.prototype.getTime);
const numberDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'valueAsNumber');
const dateDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'valueAsDate');
const nativeErrors = element => element[S.window];
function requireInput(element, errors) {
  if (!(element instanceof HTMLInputElement)) throw new (errors?.TypeError ?? TypeError)('Illegal invocation');
}

export function inputNumberValue(element) {
  requireInput(element);
  // Preserve the existing range slider's clamp/default behavior. Its full
  // value sanitization algorithm is independent of these public conversions.
  if (element.type === 'range') return numberDescriptor.get.call(element);
  return parseInputValue(element.type, element.value)?.value ?? NaN;
}

export function setInputNumberValue(element, number, errors = nativeErrors(element)) {
  requireInput(element, errors);
  if (number === Infinity || number === -Infinity) throw new errors.TypeError('valueAsNumber must not be infinite');
  if (!typedInputTypes.has(element.type) && element.type !== 'range')
    throw new errors.DOMException('This input type does not support number values', 'InvalidStateError');
  element.value = serializeInputNumber(element.type, number);
}

export function setInputDateValue(element, value, errors = nativeErrors(element)) {
  requireInput(element, errors);
  // WebIDL object? conversion happens before HTML's unsupported-type check.
  // It never invokes conversion hooks on an object supplied by the page.
  if (value != null && typeof value !== 'object' && typeof value !== 'function')
    throw new errors.TypeError('valueAsDate requires a Date or null');
  if (!dateInputTypes.has(element.type))
    throw new errors.DOMException('This input type does not support Date values', 'InvalidStateError');
  let timestamp = NaN;
  if (value != null) {
    // The intrinsic checks the internal Date slot across realms and rejects
    // proxies/forged prototypes without calling a user getTime override.
    try { timestamp = dateTime(value); }
    catch { throw new errors.TypeError('valueAsDate requires a Date or null'); }
  }
  element.value = serializeInputDate(element.type, timestamp);
}

Object.defineProperty(HTMLInputElement.prototype, 'valueAsNumber', { ...numberDescriptor,
  get() { return inputNumberValue(this); },
  set(value) { setInputNumberValue(this, +value); },
});
Object.defineProperty(HTMLInputElement.prototype, 'valueAsDate', { ...dateDescriptor,
  get() {
    requireInput(this);
    const timestamp = inputDateTimestamp(this.type, this.value);
    return timestamp === null ? null : new IntrinsicDate(timestamp);
  },
  set(value) { setInputDateValue(this, value); },
});

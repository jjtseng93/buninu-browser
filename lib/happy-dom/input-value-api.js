import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { typedInputTypes, dateInputTypes, parseInputValue, parseNumberAttribute, inputDateTimestamp, serializeInputNumber, serializeInputDate, inputStep, inputNumberBounds, steppedInputNumber } from './input-value-types.js';

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

export function stepInputValue(element, count, errors = nativeErrors(element)) {
  requireInput(element, errors);
  const type = element.type;
  if (!typedInputTypes.has(type) && type !== 'range')
    throw new errors.DOMException('This input type does not support stepping', 'InvalidStateError');
  const attribute = name => element.getAttributeNS(null, name);
  const stepAttribute = attribute('step');
  if (stepAttribute !== null && /^[aA][nN][yY]$/.test(stepAttribute))
    throw new errors.DOMException('An input with step any cannot be stepped', 'InvalidStateError');
  const number = source => type === 'number' || type === 'range' ? parseNumberAttribute(source) : parseInputValue(type, source)?.value ?? null;
  const defaults = inputStep(type), parsedStep = parseNumberAttribute(stepAttribute);
  const step = parsedStep !== null && parsedStep > 0 ? parsedStep : defaults.default;
  const minimum = number(attribute('min')), maximum = number(attribute('max'));
  const base = minimum ?? number(attribute('value')) ?? defaults.base;
  const [lowest, highest] = inputNumberBounds(type);
  const min = Math.max(lowest, minimum ?? (type === 'range' ? 0 : lowest));
  const max = Math.min(highest, maximum ?? (type === 'range' ? 100 : highest));
  const value = type === 'range' && !parseInputValue(type, element.value) ? NaN : inputNumberValue(element);
  const result = steppedInputNumber(type, value, min, max, base, step, count);
  if (result === null) return false;
  element.value = serializeInputNumber(type, result);
  return true;
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

for (const [name, direction] of [['stepUp', 1], ['stepDown', -1]]) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, name);
  Object.defineProperty(HTMLInputElement.prototype, name, { ...descriptor, value: function(n = 1) {
    requireInput(this, nativeErrors(this));
    const count = (+n | 0) * direction;
    stepInputValue(this, count);
  } });
}

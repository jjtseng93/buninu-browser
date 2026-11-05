// HTML typed input values share one parser across sanitization and validation.
// Date fields are UTC components; local Date parsing would silently normalize
// nonexistent wall times at daylight-saving transitions.
// https://html.spec.whatwg.org/multipage/input.html
const DAY = 86400000;
const WEEK = 7 * DAY;
const TIME_CLIP = 8640000000000000;
const finite = value => Number.isFinite(value) ? value : null;
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export const typedInputTypes = new Set(['number', 'date', 'month', 'week', 'time', 'datetime-local']);
export const dateInputTypes = new Set(['date', 'month', 'week', 'time']);

function midnight(year, month = 1, day = 1) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return finite(date.getTime());
}

function dateParts(source, monthOnly = false) {
  const match = (monthOnly ? /^(\d{4,})-(\d{2})$/ : /^(\d{4,})-(\d{2})-(\d{2})$/).exec(source);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = monthOnly ? 1 : Number(match[3]);
  if (!Number.isSafeInteger(year) || year < 1 || month < 1 || month > 12) return null;
  const days = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return null;
  // Match the representable control range observed in Chromium, including
  // month (275760-09). This is an implementation bound, not month syntax.
  const value = midnight(year, month, day);
  return value === null ? null : { value, year, month, day };
}

function timeParts(source) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(source);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Number((match[4] ?? '').padEnd(3, '0'));
  const fraction = milliseconds ? `.${String(milliseconds).padStart(3, '0').replace(/0+$/, '')}` : '';
  const normalized = `${match[1]}:${match[2]}` + (second || milliseconds ? `:${String(second).padStart(2, '0')}${fraction}` : '');
  return { value: ((hour * 60 + minute) * 60 + second) * 1000 + milliseconds, normalized };
}

// A value string must be a valid floating-point number. In contrast, HTML's
// attribute parsing algorithm accepts an ASCII-whitespace/sign/numeric prefix.
// Do not use Number('') (zero) or parseFloat's wider Unicode whitespace rules.
export function parseInputNumber(source) {
  return typeof source === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)
    ? finite(Number(source)) : null;
}
export function parseNumberAttribute(source) {
  if (typeof source !== 'string') return null;
  const match = /^[\t\n\f\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source);
  return match ? finite(Number(match[1])) : null;
}

export function parseInputValue(type, source) {
  if (typeof source !== 'string' || source === '') return null;
  if (type === 'number' || type === 'range') {
    const value = parseInputNumber(source);
    return value === null ? null : { value, text: source };
  }
  if (type === 'date' || type === 'month') {
    const date = dateParts(source, type === 'month');
    return date ? { value: type === 'date' ? date.value : (date.year - 1970) * 12 + date.month - 1, text: source } : null;
  }
  if (type === 'time') {
    const time = timeParts(source);
    return time ? { value: time.value, text: source } : null;
  }
  if (type === 'datetime-local') {
    const match = /^(\d{4,}-\d{2}-\d{2})[T ](.+)$/.exec(source);
    if (!match) return null;
    const date = dateParts(match[1]), time = timeParts(match[2]);
    if (!date || !time || date.value + time.value > TIME_CLIP) return null;
    return {
      value: date.value + time.value,
      text: `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}T${time.normalized}`,
    };
  }
  if (type === 'week') {
    const match = /^(\d{4,})-W(\d{2})$/.exec(source);
    if (!match) return null;
    const year = Number(match[1]), week = Number(match[2]);
    if (!Number.isSafeInteger(year) || year < 1 || week < 1 || week > 53) return null;
    const january = midnight(year);
    if (january === null) return null;
    const weekday = new Date(january).getUTCDay();
    if (week === 53 && weekday !== 4 && !(weekday === 3 && leap(year))) return null;
    const fourth = january + 3 * DAY;
    const monday = fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY;
    const value = monday + (week - 1) * WEEK;
    return value > TIME_CLIP ? null : { value, text: source };
  }
  return null;
}

export function inputDateTimestamp(type, source) {
  if (!dateInputTypes.has(type)) return null;
  return type === 'month' ? dateParts(source, true)?.value ?? null : parseInputValue(type, source)?.value ?? null;
}

const pad = (value, width = 2) => String(value).padStart(width, '0');
// Numeric date controls serialize whole milliseconds/months, with half ties
// away from zero as in Chromium. Time controls instead take the current
// millisecond within the periodic day, including negative/huge finite inputs.
const rounded = value => {
  const integer = Math.trunc(value);
  return integer + (Math.abs(value - integer) >= 0.5 ? Math.sign(value) : 0);
};
function formatTime(number) {
  let value = Math.floor(number % DAY);
  if (value < 0) value += DAY;
  const hour = Math.floor(value / 3600000), minute = Math.floor(value / 60000) % 60;
  const second = Math.floor(value / 1000) % 60, milliseconds = value % 1000;
  return `${pad(hour)}:${pad(minute)}` + (second || milliseconds ? `:${pad(second)}` : '')
    + (milliseconds ? `.${pad(milliseconds, 3).replace(/0+$/, '')}` : '');
}
function formatDate(date) {
  const year = date.getUTCFullYear();
  return Number.isFinite(year) && year >= 1 ? `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` : '';
}
function formatWeek(number) {
  const day = Math.floor(number / DAY), weekday = ((day + 4) % 7 + 7) % 7;
  const monday = (day - (weekday + 6) % 7) * DAY;
  if (!Number.isFinite(monday) || monday > TIME_CLIP || monday < -62135596800000) return '';
  const year = new Date(monday + 3 * DAY).getUTCFullYear();
  const fourth = midnight(year, 1, 4);
  const first = fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY;
  const result = `${pad(year, 4)}-W${pad(Math.floor((monday - first) / WEEK) + 1)}`;
  return parseInputValue('week', result)?.text ?? '';
}

export function serializeInputNumber(type, number) {
  if (!Number.isFinite(number)) return '';
  if (type === 'number' || type === 'range') return String(number);
  if (type === 'time') return formatTime(number);
  const value = rounded(number);
  if (type === 'week') return formatWeek(value);
  if (type === 'month') {
    const year = 1970 + Math.floor(value / 12), month = ((value % 12) + 12) % 12 + 1;
    const result = `${pad(year, 4)}-${pad(month)}`;
    return parseInputValue(type, result)?.text ?? '';
  }
  const date = formatDate(new Date(value));
  if (!date) return '';
  return type === 'date' ? date : type === 'datetime-local' ? `${date}T${formatTime(value)}` : '';
}

export function serializeInputDate(type, timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  if (type === 'month') return formatDate(new Date(timestamp)).replace(/-\d{2}$/, '');
  return dateInputTypes.has(type) ? serializeInputNumber(type, timestamp) : '';
}

export function inputStep(type) {
  if (type === 'date') return { scale: DAY, default: 1, base: 0 };
  if (type === 'week') return { scale: WEEK, default: 1, base: -3 * DAY };
  if (type === 'time' || type === 'datetime-local') return { scale: 1000, default: 60, base: 0 };
  return { scale: 1, default: 1, base: 0 };
}

// Only finite, already converted numbers reach this function. Their canonical
// decimal strings bound coefficient length and powers of ten (roughly ±324),
// regardless of the length/exponent of an untrusted source attribute.
function decimal(number) {
  const [mantissa, exponent = '0'] = String(number).split('e');
  const point = mantissa.indexOf('.');
  return { coefficient: BigInt(mantissa.replace('.', '')), exponent: Number(exponent) - (point < 0 ? 0 : mantissa.length - point - 1) };
}

export function inputStepMismatch(value, base, step, scale = 1) {
  const a = decimal(value), b = decimal(base), s = decimal(step);
  s.coefficient *= BigInt(scale);
  const exponent = Math.min(a.exponent, b.exponent, s.exponent);
  const integer = operand => operand.coefficient * 10n ** BigInt(operand.exponent - exponent);
  return (integer(a) - integer(b)) % integer(s) !== 0n;
}

export function inputNumberBounds(type) {
  if (type === 'time') return [0, DAY - 1];
  if (type === 'month') return [-23628, 3285488]; // 0001-01 .. 275760-09
  if (type === 'week') return [-62135596800000, 8639999568000000];
  if (type === 'date' || type === 'datetime-local') return [-62135596800000, TIME_CLIP];
  return [-Number.MAX_VALUE, Number.MAX_VALUE];
}

// These operations implement the observable Chromium/WPT stepping behavior,
// independently of Chromium's LGPL stepping implementation: signed counts,
// one snap consuming one step, and missing-value clamping. Calendar controls
// have whole-unit steps; time controls have whole-millisecond steps. Numeric
// controls keep the exact canonical decimal, without binary64 accumulation.
function steppingDecimal(type, step) {
  const result = decimal(step), {scale} = inputStep(type);
  if (type === 'number' || type === 'range') return result;
  if (type === 'time' || type === 'datetime-local') result.coefficient *= BigInt(scale);
  let integer;
  if (result.exponent >= 0) integer = result.coefficient * 10n ** BigInt(result.exponent);
  else {
    const divisor = 10n ** BigInt(-result.exponent);
    integer = (result.coefficient + divisor / 2n) / divisor;
  }
  if (integer < 1n) integer = 1n;
  if (type === 'date' || type === 'week') integer *= BigInt(scale);
  return {coefficient: integer, exponent: 0};
}

function floorRatio(value, divisor) {
  const quotient = value / divisor;
  return quotient - (value % divisor < 0n ? 1n : 0n);
}
const ceilRatio = (value, divisor) => -floorRatio(-value, divisor);

// null is a genuine no-op (no dirty-value change); a returned number must be
// assigned even for a zero count. Parameters have already passed finite/type
// parsing, so arbitrary input exponent text cannot grow the BigInt work.
export function steppedInputNumber(type, value, min, max, base, step, count) {
  if (min > max) return null;
  const invalid = !Number.isFinite(value), missing = invalid && type !== 'range';
  const operands = [decimal(invalid ? 0 : value), decimal(min), decimal(max), decimal(base), steppingDecimal(type, step)];
  const exponent = Math.min(...operands.map(operand => operand.exponent));
  let [current, minimum, maximum, origin, stride] = operands.map(operand => operand.coefficient * 10n ** BigInt(operand.exponent - exponent));
  const lower = origin + ceilRatio(minimum - origin, stride) * stride;
  const upper = origin + floorRatio(maximum - origin, stride) * stride;
  if (lower > upper) return null;
  if (invalid && type === 'range') {
    // A pristine range has a midpoint default, aligned to its step. Resolve
    // this lazily without first assigning a value or changing dirty state.
    const distance = minimum + maximum - 2n * origin;
    const index = floorRatio(distance, 2n * stride);
    const remainder = distance - index * 2n * stride;
    current = origin + (index + (remainder >= stride ? 1n : 0n)) * stride;
    if (current < lower) current = lower;
    if (current > upper) current = upper;
  }
  const increment = BigInt(count);
  let next;
  if (increment !== 0n && (current - origin) % stride !== 0n) {
    const sign = increment > 0n ? 1n : -1n;
    const aligned = increment > 0n ? ceilRatio(current - origin, stride) : floorRatio(current - origin, stride);
    next = origin + (aligned + increment - sign) * stride;
  } else next = current + increment * stride;
  if (next < minimum) next = lower;
  if (next > maximum) next = upper;
  if (!missing && (increment > 0n && next < current || increment < 0n && next > current)) return null;
  return Number(`${next}e${exponent}`);
}

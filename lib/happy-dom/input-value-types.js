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

// API serialization chooses the shortest time, unlike assigning .value,
// which preserves valid explicit zero seconds and fractional digits.
export function canonicalInputTime(source) {
  return timeParts(source)?.normalized ?? '';
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

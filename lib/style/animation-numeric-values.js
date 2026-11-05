// Numeric animation longhands share the same grammar in CSSOM, feature
// queries and the cascade. Math is typed before range restrictions apply:
// a negative literal duration is invalid, while calc(-1s) computes to 0s.
const initial = new Map([
  ['animation-duration', '0s'], ['animation-delay', '0s'],
  ['animation-iteration-count', '1'],
]);
const factors = new Map([
  ['s', ['time', 1]], ['ms', ['time', .001]],
  ['px', ['length', 1]], ['in', ['length', 96]], ['cm', ['length', 96 / 2.54]],
  ['mm', ['length', 96 / 25.4]], ['q', ['length', 96 / 101.6]],
  ['pt', ['length', 4 / 3]], ['pc', ['length', 16]],
  ['deg', ['angle', 1]], ['grad', ['angle', .9]], ['rad', ['angle', 180 / Math.PI]], ['turn', ['angle', 360]],
  ['hz', ['frequency', 1]], ['khz', ['frequency', 1000]],
  ['dppx', ['resolution', 1]], ['x', ['resolution', 1]], ['dpi', ['resolution', 1 / 96]], ['dpcm', ['resolution', 2.54 / 96]],
]);
const relativeLength = /^(?:r?(?:em|ex|cap|ch|ic|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const number = value => ({ value, type: {} });
const dimensional = (value, unit, resolveRelative) => {
  unit = unit.toLowerCase();
  const factor = factors.get(unit);
  if (factor) return {value: value * factor[1], type: {[factor[0]]: 1}};
  if (relativeLength.test(unit)) {
    const scale = resolveRelative?.(`1${unit}`);
    if (resolveRelative && !Number.isFinite(scale)) return null;
    return {value: resolveRelative ? value * scale : NaN, type: {length: 1}};
  }
  if (unit === '%') return {value, type: {percent: 1}};
  return null;
};
const typeKey = type => Object.keys(type).filter(key => type[key]).sort().map(key => `${key}:${type[key]}`).join(',');
const sameType = (a, b) => typeKey(a.type) === typeKey(b.type);
const isNumber = value => !Object.values(value.type).some(Boolean);

export const animationNumericInitial = name => initial.get(name);

// Properties such as opacity can share typed arithmetic without the animation
// grammar/ranges. Relative lengths need layout context; reject them here so a
// computed NaN (which CSS resolves to zero) cannot hide an unresolved length.
export const hasRelativeCSSUnits = token => token.kind === 'dimension' && relativeLength.test(token.unit.toLowerCase())
  || Boolean(token.args?.some(hasRelativeCSSUnits));

export function absoluteCSSNumericValue(token) {
  return hasRelativeCSSUnits(token) ? null : numeric(token, 0);
}

// With no resolver this validates the result's type without inventing a
// font/container size. An unresolved relative value is NaN, distinct from
// a null result (invalid syntax/type or unavailable computed context).
export function typedCSSNumericValue(token, resolveRelative) {
  return numeric(token, 0, resolveRelative);
}

export function animationNumericToken(name, token) {
  if (!initial.has(name)) return undefined;
  if (token.kind === 'ident') {
    const keyword = token.value.toLowerCase();
    if (name === 'animation-duration' && keyword === 'auto' || name === 'animation-iteration-count' && keyword === 'infinite') return keyword;
    return null;
  }
  if (!['number', 'dimension', 'function'].includes(token.kind)) return null;
  const math = token.kind === 'function';
  const value = numeric(token, 0);
  if (!value || (name === 'animation-iteration-count' ? !isNumber(value) : typeKey(value.type) !== 'time:1')) return null;
  if (!math && name !== 'animation-delay' && value.value < 0) return null;
  // Preserve relative and nonfinite calculations until a computed-value
  // resolver has enough context. Do not accidentally turn NaN into a number.
  if (math && !Number.isFinite(value.value)) return token.source;
  if (math) return `calc(${format(value.value)}${name === 'animation-iteration-count' ? '' : 's'})`;
  return `${format(finiteLiteral(token.value))}${token.kind === 'dimension' ? token.unit.toLowerCase() : ''}`;
}

export function animationNumericComputed(name, value, parse, resolveRelative) {
  if (!initial.has(name)) return value;
  if (value === 'auto') return '0s';
  if (value === 'infinite') return value;
  const tokens = parse(value)?.tokens;
  if (!tokens || tokens.length !== 1) return value;
  const result = numeric(tokens[0], 0, resolveRelative);
  if (!result || !Number.isFinite(result.value)) return value;
  const resolved = name === 'animation-delay' ? result.value : Math.max(0, result.value);
  return `${format(resolved)}${name === 'animation-iteration-count' ? '' : 's'}`;
}

function format(value) { return String(Object.is(value, -0) ? 0 : value); }
const finiteLiteral = value => Math.max(-3.4028234663852886e38, Math.min(3.4028234663852886e38, Number(value)));

function numeric(token, depth, resolveRelative) {
  if (!token || depth > 128) return null;
  if (token.kind === 'number') return number(Number(token.value));
  if (token.kind === 'dimension') return dimensional(Number(token.value), token.unit, resolveRelative);
  if (token.kind === 'ident') {
    const constants = {pi: Math.PI, e: Math.E, infinity: Infinity, '-infinity': -Infinity, nan: NaN};
    const key = token.value.toLowerCase();
    return Object.hasOwn(constants, key) ? number(constants[key]) : null;
  }
  if (token.kind !== 'function' && token.kind !== 'block') return null;
  if (token.kind === 'block' && token.bracket !== '(') return null;
  let at = 0;
  const tokens = token.args;
  const name = token.kind === 'block' ? 'calc' : token.name;
  let rounding = 'nearest';
  if (name === 'round' && tokens[0]?.kind === 'ident' && ['nearest', 'up', 'down', 'to-zero'].includes(tokens[0].value.toLowerCase())) {
    rounding = tokens[0].value.toLowerCase();
    if (tokens[1]?.kind !== ',') return null;
    at = 2;
  }
  const primary = () => numeric(tokens[at++], depth + 1, resolveRelative);
  const product = () => {
    let value = primary();
    while (value && (tokens[at]?.kind === '*' || tokens[at]?.kind === '/')) {
      const divide = tokens[at++].kind === '/';
      const right = primary();
      if (!right) return null;
      const type = {...value.type};
      for (const [key, exponent] of Object.entries(right.type)) type[key] = (type[key] ?? 0) + exponent * (divide ? -1 : 1);
      value = {value: divide ? value.value / right.value : value.value * right.value, type};
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (value && (tokens[at]?.kind === '+' || tokens[at]?.kind === '-')) {
      const operator = tokens[at++];
      if (!operator.spaced) return null;
      const right = product();
      if (!right || !sameType(value, right)) return null;
      value = {...value, value: value.value + (operator.kind === '+' ? 1 : -1) * right.value};
    }
    return value;
  };
  const args = [];
  while (at < tokens.length) {
    const value = sum();
    if (!value) return null;
    args.push(value);
    if (at === tokens.length) break;
    if (tokens[at++]?.kind !== ',' || at === tokens.length) return null;
  }
  if (name === 'round') {
    if (args.length === 1 && isNumber(args[0])) args.push(number(1));
    if (args.length !== 2 || !sameType(args[0], args[1])) return null;
    const operation = rounding === 'up' ? Math.ceil : rounding === 'down' ? Math.floor : rounding === 'to-zero' ? Math.trunc : Math.round;
    return {...args[0], value: operation(args[0].value / args[1].value) * args[1].value};
  }
  if (name === 'calc') return args.length === 1 ? args[0] : null;
  if (name === 'abs' || name === 'sign') return args.length === 1 ? (name === 'sign' ? number(Math.sign(args[0].value)) : {...args[0], value: Math.abs(args[0].value)}) : null;
  if (['min', 'max', 'clamp', 'hypot'].includes(name)) {
    if (!args.length || name === 'clamp' && args.length !== 3 || args.some(arg => !sameType(args[0], arg))) return null;
    const values = args.map(arg => arg.value);
    const value = name === 'clamp' ? Math.max(values[0], Math.min(values[1], values[2])) : values.reduce((result, current) => Math[name](result, current), name === 'min' ? Infinity : name === 'max' ? -Infinity : 0);
    return {...args[0], value};
  }
  if (name === 'mod' || name === 'rem') {
    if (args.length !== 2 || !sameType(args[0], args[1])) return null;
    const [a, b] = args.map(arg => arg.value);
    return {...args[0], value: name === 'rem' ? a % b : a - b * Math.floor(a / b)};
  }
  if (['sqrt', 'exp', 'pow', 'log'].includes(name)) {
    const validCount = name === 'pow' ? args.length === 2 : name === 'log' ? args.length === 1 || args.length === 2 : args.length === 1;
    if (!validCount || !args.every(isNumber)) return null;
    const values = args.map(arg => arg.value);
    return number(name === 'log' ? Math.log(values[0]) / (values.length === 2 ? Math.log(values[1]) : 1) : Math[name](...values));
  }
  if (['sin', 'cos', 'tan'].includes(name)) {
    if (args.length !== 1 || !isNumber(args[0]) && typeKey(args[0].type) !== 'angle:1') return null;
    return number(Math[name](args[0].value * (isNumber(args[0]) ? 1 : Math.PI / 180)));
  }
  if (['asin', 'acos', 'atan', 'atan2'].includes(name)) {
    if (name === 'atan2' ? args.length !== 2 || !sameType(args[0], args[1]) : args.length !== 1 || !isNumber(args[0])) return null;
    return {value: Math[name](...args.map(arg => arg.value)) * 180 / Math.PI, type: {angle: 1}};
  }
  return null;
}

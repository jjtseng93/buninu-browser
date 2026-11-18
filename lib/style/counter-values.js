import {parseCSSComponentValues} from './css-value-tokens.js';

const wide = new Set(['initial','inherit','unset','revert','revert-layer']);
export function counterIdentifier(token) {
  if (token?.kind !== 'ident') return false;
  const keyword = token.value.toLowerCase();
  return !wide.has(keyword) && keyword !== 'default' && keyword !== 'none';
}

export function counterEntries(tokens, initial) {
  if (!tokens.length) return null;
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!counterIdentifier(token)) return null;
    let value = initial;
    if (tokens[i+1]?.kind === 'number') {
      const number = tokens[++i].value;
      if (!/^[+-]?\d+$/.test(number)) return null;
      value = Math.min(2147483647, Math.max(-2147483648, Number(number)));
    }
    entries.push({name:token.value, source:token.source, value});
  }
  return entries;
}

export function normalizeCounter(name, text, allowPending) {
  const parsed = parseCSSComponentValues(text);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? text : null;
  const {tokens} = parsed;
  if (tokens.length === 1 && tokens[0].kind === 'ident') {
    const keyword = tokens[0].value.toLowerCase();
    if (keyword === 'none' || wide.has(keyword)) return keyword;
  }
  return counterEntries(tokens, name === 'counter-increment' ? 1 : 0)
    ?.map(entry=>entry.source + ' ' + entry.value).join(' ') ?? null;
}

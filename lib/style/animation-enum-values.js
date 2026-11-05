// Validation is shared by CSSOM, feature queries and the rendering cascade.
// These longhands accept comma-separated identifiers, not arbitrary CSS text.
const grammars = new Map([
  ['animation-direction', ['normal', 'reverse', 'alternate', 'alternate-reverse']],
  ['animation-fill-mode', ['none', 'forwards', 'backwards', 'both']],
  ['animation-play-state', ['running', 'paused']],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const space = c => c !== undefined && /[ \t\n\r\f]/.test(c);
const nameChar = c => c !== undefined && (/[a-z\d_-]/i.test(c) || c.charCodeAt(0) >= 0x80);

/** undefined: not handled; null: invalid; string: normalized or pending substitution. */
export function normalizeAnimationEnum(name, input, allowPending = true) {
  const grammar = grammars.get(name);
  if (!grammar) return undefined;
  const text = String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  const parsed = components(text);
  if (!parsed) return null;
  // Substitution is validated again at computed-value time. Other tokens in
  // an unresolved value may become valid only after var()/env() replacement.
  if (parsed.pending) return allowPending ? text : null;
  const tokens = parsed.tokens;
  if (tokens.length === 1 && tokens[0].kind === 'ident' && wide.has(tokens[0].value.toLowerCase()))
    return tokens[0].value.toLowerCase();
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 ? token.kind !== ',' : token.kind !== 'ident' || !grammar.includes(token.value.toLowerCase())) return null;
    if (i % 2 === 0) values.push(token.value.toLowerCase());
  }
  return tokens.length % 2 ? values.join(', ') : null;
}

/** Resolved enum value, including a shorthand's value and the initial default. */
export function animationEnumValue(style, name) {
  const grammar = grammars.get(name);
  if (!grammar) return undefined;
  const key = name.slice(10).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return (style.cssAnimationLonghands?.[key] ?? style.cssAnimations?.map(item => item[key]) ?? [grammar[0]]).join(', ');
}

// A small component-value tokenizer: identifiers are decoded before keyword
// matching; comments separate tokens; functions/blocks keep their own commas.
// This also avoids treating "var(...)" inside a quoted string as substitution.
function components(text) {
  let at = 0, pending = false;
  function identifier() {
    let value = '';
    while (at < text.length) {
      const c = text[at];
      if (nameChar(c)) { value += c; at++; continue; }
      if (c !== '\\') break;
      at++;
      if (at === text.length || /[\n\r\f]/.test(text[at])) return null;
      const hex = /^[\da-f]{1,6}/i.exec(text.slice(at, at + 6));
      if (hex) {
        const code = parseInt(hex[0], 16);
        value += String.fromCodePoint(!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff ? 0xfffd : code);
        at += hex[0].length;
        if (text[at] === '\r' && text[at + 1] === '\n') at++;
        if (space(text[at])) at++;
      } else value += text[at++];
    }
    return value;
  }
  function list(close = '', depth = 0) {
    if (depth > 128) return null;
    const tokens = [];
    while (at < text.length) {
      const c = text[at];
      if (space(c)) { at++; continue; }
      if (c === '/' && text[at + 1] === '*') {
        const end = text.indexOf('*/', at + 2); at = end < 0 ? text.length : end + 2; continue;
      }
      if (c === close) { at++; return tokens; }
      if (')]}'.includes(c) || !depth && (c === ';' || c === '!')) return null;
      if (c === '"' || c === "'") {
        at++; let ended = false;
        while (at < text.length) {
          const next = text[at++];
          if (next === c) { ended = true; break; }
          if (/[\n\r\f]/.test(next)) return null;
          if (next === '\\' && at < text.length) at++;
        }
        if (!ended) return null;
        tokens.push({kind:'string'}); continue;
      }
      if ('([{'.includes(c)) {
        at++;
        if (!list({'(':')','[':']','{':'}'}[c], depth + 1)) return null;
        tokens.push({kind:c === '{' ? 'brace' : 'block'}); continue;
      }
      const number = /[+\d.-]/.test(c) ? /^[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at)) : null;
      if (number) {
        at += number[0].length;
        let kind = 'number';
        if (nameChar(text[at]) || text[at] === '\\') { if (identifier() === null) return null; kind = 'dimension'; }
        else if (text[at] === '%') { at++; kind = 'dimension'; }
        tokens.push({kind, value:number[0]}); continue;
      }
      if (nameChar(c) || c === '\\') {
        const value = identifier();
        if (value === null) return null;
        if (text[at] === '(') {
          at++; const args = list(')', depth + 1), name = value.toLowerCase();
          if (!args) return null;
          if (name === 'var' || name === 'env') {
            if (args[0]?.kind !== 'ident' || name === 'var' && (!args[0].value.startsWith('--') || args[0].value.length < 3)) return null;
            let i = 1;
            if (name === 'env') while (args[i]?.kind === 'number' && /^[+-]?\d+$/.test(args[i].value) && Number(args[i].value) >= 0) i++;
            if (args[i] && args[i].kind !== ',') return null;
            if (args.slice(i + 1).some(token => token.kind === ';' || token.kind === '!')) return null;
            pending = true;
          }
          // url(var(...)) is a bad URL token, not a variable reference.
          if (name === 'url' && args.some(token => token.kind === 'function' || token.kind === 'block' || token.kind === 'brace')) return null;
          tokens.push({kind:'function'});
        } else {
          tokens.push({kind:'ident', value});
        }
        continue;
      }
      at++; tokens.push({kind:c});
    }
    return close ? null : tokens;
  }
  const tokens = list();
  // Ordinary properties reject a {} block positioned beside other values,
  // including pending substitutions (CSS Syntax declaration-value grammar).
  if (tokens?.length > 1 && tokens.some(token => token.kind === 'brace')) return null;
  return tokens ? {tokens, pending} : null;
}

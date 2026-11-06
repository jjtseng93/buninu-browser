// CSS whitespace excludes NBSP and the other Unicode spaces used in identifiers.
export const trimCSSWhitespace = text => text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
const space = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const newline = c => c === '\n' || c === '\r' || c === '\f';
// These helpers see one UTF-16 code unit (or undefined at a boundary). Avoid
// running a RegExp for every character of every property value during restyle.
const nameChar = c => {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return code >= 0x80 || code >= 65 && code <= 90 || code >= 97 && code <= 122 ||
    code >= 48 && code <= 57 || code === 45 || code === 95;
};

// A small component-value tokenizer: identifiers are decoded before keyword
// matching; comments separate tokens; functions/blocks keep their own commas.
// This also avoids treating "var(...)" inside a quoted string as substitution.
export function parseCSSComponentValues(text) {
  let at = 0, pending = false;
  function identifier() {
    let value = '';
    while (at < text.length) {
      const c = text[at];
      if (nameChar(c)) { value += c; at++; continue; }
      if (c !== '\\') break;
      at++;
      if (at === text.length || newline(text[at])) return null;
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
        const start=at;at++; let ended = false;
        while (at < text.length) {
          const next = text[at++];
          if (next === c) { ended = true; break; }
          if (newline(next)) return null;
          if (next === '\\' && at < text.length) {
            if(text[at]==='\r'&&text[at+1]==='\n')at++;
            at++;
          }
        }
        if (!ended) return null;
        tokens.push({kind:'string',source:text.slice(start,at)}); continue;
      }
      if ('([{'.includes(c)) {
        at++;
        const args = list({'(':')','[':']','{':'}'}[c], depth + 1);
        if (!args) return null;
        tokens.push({kind:c === '{' ? 'brace' : 'block', bracket:c, args}); continue;
      }
      if (c === '#' && (nameChar(text[at + 1]) || text[at + 1] === '\\')) {
        at++; const value = identifier();
        if (value === null) return null;
        tokens.push({kind:'hash', value}); continue;
      }
      const number = (c === '+' || c === '-' || c === '.' || c >= '0' && c <= '9') ? /^[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at)) : null;
      if (number) {
        at += number[0].length;
        let kind = 'number', unit = '';
        if (nameChar(text[at]) || text[at] === '\\') { unit = identifier(); if (unit === null) return null; kind = 'dimension'; }
        else if (text[at] === '%') { at++; kind = 'dimension'; unit = '%'; }
        tokens.push({kind, value:number[0], unit}); continue;
      }
      if (nameChar(c) && !(c === '-' && !nameChar(text[at + 1]) && text[at + 1] !== '\\') || c === '\\') {
        const start = at, value = identifier();
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
          tokens.push({kind:'function', name, args, source:text.slice(start, at)});
        } else {
          tokens.push({kind:'ident', value,source:text.slice(start,at)});
        }
        continue;
      }
      const spaced = space(text[at - 1]) && space(text[at + 1]);
      at++; tokens.push({kind:c, spaced});
    }
    return close ? null : tokens;
  }
  const tokens = list();
  // Ordinary properties reject a {} block positioned beside other values,
  // including pending substitutions (CSS Syntax declaration-value grammar).
  if (tokens?.length > 1 && tokens.some(token => token.kind === 'brace')) return null;
  return tokens ? {tokens, pending} : null;
}

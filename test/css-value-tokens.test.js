import {test, expect} from 'bun:test';
import {parseCSSComponentValues as parse, trimCSSWhitespace} from '../lib/style/css-value-tokens.js';

test('CSS component values distinguish ASCII whitespace from non-ASCII name characters', () => {
  const name = 'AZaz_09-\u00a0\u2003Kſ😀\ud800';
  expect(parse(` \t\n\r\f${name}\t `)).toEqual({
    tokens: [{kind: 'ident', value: name, source: name}], pending: false,
  });
  expect(trimCSSWhitespace(` \t${name}\f\r\n`)).toBe(name);
  expect(parse('a\0b')).toEqual({tokens: [
    {kind: 'ident', value: 'a', source: 'a'},
    {kind: '\0', spaced: false},
    {kind: 'ident', value: 'b', source: 'b'},
  ], pending: false});
  expect(parse('0\t+2.5px\n-.5%\r3e+2\f4E-2s')).toEqual({tokens: [
    {kind: 'number', value: '0', unit: ''},
    {kind: 'dimension', value: '+2.5', unit: 'px'},
    {kind: 'dimension', value: '-.5', unit: '%'},
    {kind: 'number', value: '3e+2', unit: ''},
    {kind: 'dimension', value: '4E-2', unit: 's'},
  ], pending: false});
});

test('CSS identifier escapes retain hex boundaries and invalid-codepoint replacement', () => {
  const source = '\\61\r\nb \\0 \\D800 \\110000';
  expect(parse(source)).toEqual({tokens: [
    {kind: 'ident', value: 'ab', source: '\\61\r\nb'},
    {kind: 'ident', value: '\ufffd\ufffd\ufffd', source: '\\0 \\D800 \\110000'},
  ], pending: false});
  expect(parse('#\\41 BC').tokens).toEqual([{kind: 'hash', value: 'ABC'}]);
  for (const ending of ['\\', '-\\', '#\\', 'abc\\\n', 'abc\\\r', 'abc\\\f'])
    expect(parse(ending)).toBeNull();
});

test('CSS strings reject raw newlines but preserve escaped continuations and delimiters', () => {
  for (const ending of ['\n', '\r', '\f', '\r\n']) {
    expect(parse(`"a${ending}b"`)).toBeNull();
    const source = `"a\\${ending}b"`;
    expect(parse(source)).toEqual({tokens: [{kind: 'string', source}], pending: false});
  }
  expect(parse('"var(--x)"').pending).toBeFalse();
  expect(parse('calc(1px + var(--x, 2px))').pending).toBeTrue();
  expect(parse('f('.repeat(129) + 'x' + ')'.repeat(129))).toBeNull();
  for (const source of ['"unterminated', 'calc(1px', '1px)', '[x}', '1px;2px'])
    expect(parse(source)).toBeNull();
});

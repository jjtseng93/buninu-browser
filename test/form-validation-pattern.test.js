import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';

function input(type = 'text') {
  const { document } = parseHTMLDocument('<input>');
  const element = document.querySelector('input');
  element.type = type;
  return element;
}

test('input patterns require a full match and track later attribute and value changes', () => {
  const element = input();
  element.pattern = 'a|bc';
  element.value = 'a';
  expect(element.validity.patternMismatch).toBeFalse();
  element.value = 'abc';
  expect(element.validity.patternMismatch).toBeTrue();
  element.pattern = 'abc';
  expect(element.validity.patternMismatch).toBeFalse();
  element.pattern = '';
  expect(element.validity.patternMismatch).toBeTrue();
  element.removeAttribute('pattern');
  expect(element.validity.patternMismatch).toBeFalse();
});

test('invalid standalone and UnicodeSets patterns are ignored without throwing', () => {
  const element = input();
  element.value = 'de';
  for (const pattern of ['(', '[(]', 'a)(b', '[a-']) {
    element.pattern = pattern;
    expect(element.validity.patternMismatch).toBeFalse();
    expect(element.validity.patternMismatch).toBeFalse();
  }
  element.pattern = 'de';
  expect(element.validity.patternMismatch).toBeFalse();
});

test('patterns use UnicodeSets, Unicode escapes, and whole-value matching', () => {
  const element = input();
  element.pattern = String.raw`[[a-z]&&[^aeiou]]+`;
  element.value = 'bcdf';
  expect(element.validity.patternMismatch).toBeFalse();
  element.value = 'bcde';
  expect(element.validity.patternMismatch).toBeTrue();
  element.pattern = String.raw`a\u{10FFFF}`;
  element.value = 'a\u{10FFFF}';
  expect(element.validity.patternMismatch).toBeFalse();
});

test('multiple email patterns validate each trimmed address; text multiple has no effect', () => {
  const element = input('email');
  element.multiple = true;
  element.pattern = '.+@example\\.com';
  element.value = 'one@example.com, two@example.com';
  expect(element.validity.patternMismatch).toBeFalse();
  element.value = 'one@example.com,two@elsewhere.test';
  expect(element.validity.patternMismatch).toBeTrue();
  element.type = 'text';
  element.pattern = '[A-Z]';
  element.value = 'A,A';
  expect(element.validity.patternMismatch).toBeTrue();
});

test('patterns apply only to text-like input states and do not reject empty values', () => {
  const element = input();
  element.pattern = '[A-Z]';
  expect(element.validity.patternMismatch).toBeFalse();
  element.value = 'a';
  element.disabled = true;
  expect(element.validity.patternMismatch).toBeTrue();
  for (const type of ['hidden', 'number', 'range', 'date', 'checkbox', 'radio', 'submit', 'button']) {
    element.type = type;
    expect(element.validity.patternMismatch).toBeFalse();
  }
});

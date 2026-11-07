import {afterAll, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Inspect the actual allowlist and both unskipped normalization chains without
// exporting implementation details from production. As in the cache oracle
// tests, only this independent temporary module gains the private exports.
const moduleURL = new URL('../lib/style/computed-style.js', import.meta.url);
const source = readFileSync(moduleURL, 'utf8')
  .replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(new URL(specifier, moduleURL).href)}`)
  .replace(/^import\s+(["'])(\.[^"']+)\1/gm, (_match, _quote, specifier) =>
    `import ${JSON.stringify(new URL(specifier, moduleURL).href)}`);
const directory = mkdtempSync(join(tmpdir(), 'buninu-setter-normalizers-'));
afterAll(() => rmSync(directory, {recursive: true, force: true}));
const path = join(directory, 'computed-style-inspect.mjs');
writeFileSync(path, source + '\nexport {SETTER_ONLY_PROPERTIES, validatedDeclarationValue, normalizedPropertyValue};\n');
const {SETTER_ONLY_PROPERTIES, validatedDeclarationValue, normalizedPropertyValue} =
  await import(pathToFileURL(path).href);

test('every setter-only property remains untouched by both shared normalization chains', () => {
  expect(SETTER_ONLY_PROPERTIES.size).toBeGreaterThan(0);
  // Invalid, pending, CSS-wide, relative and oversized values must all survive
  // unchanged. Adding a grammar for one of these names requires removing it
  // from the allowlist; this test deliberately has no duplicate property list.
  const values = ['', '\0', 'invalid()', 'var(--x)', 'inherit', 'unset',
    'currentcolor', '2em', 'calc(1em + 3px)', 'x'.repeat(513)];
  for (const name of SETTER_ONLY_PROPERTIES) {
    expect(name).toBe(name.toLowerCase());
    for (const value of values) {
      expect(validatedDeclarationValue(name, value, false), `${name}: validation of ${JSON.stringify(value)}`).toBe(value);
      expect(normalizedPropertyValue(name, value), `${name}: normalization of ${JSON.stringify(value)}`).toBe(value);
    }
  }
});

test('setter-only names are rejected by grammar dispatch before reading the value', () => {
  // This bypasses the syntax caches and detects a newly claimed property even
  // if its normalizer happens to return every sampled string unchanged.
  const unreadable = {toString() {throw new Error('shared grammar inspected a setter-only value');}};
  for (const name of SETTER_ONLY_PROPERTIES) {
    expect(validatedDeclarationValue(name, unreadable, false), name).toBe(unreadable);
    expect(normalizedPropertyValue(name, unreadable), name).toBe(unreadable);
  }
});

test('the oracle still runs shared validation and normalization for handled properties', () => {
  expect(validatedDeclarationValue('width', 'none', false)).toBe('unset');
  expect(normalizedPropertyValue('width', 'none')).toBeNull();
  expect(normalizedPropertyValue('overflow', 'HIDDEN')).toBe('hidden');
});

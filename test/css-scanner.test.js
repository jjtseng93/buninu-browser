import {expect, test} from 'bun:test';
import {scanStyleSheet} from '../lib/style/css-scanner.js';
import {parseStyleSheet, extractAnimationKeyframes, extractFontFaces} from '../lib/style/computed-style.js';

const padding = ' '.repeat(65536);

function parsed(css, viewport) {
  return {
    rules: parseStyleSheet(css, viewport).map(rule => [rule.selector, rule.pseudo, rule.order, rule.declarations]),
    keyframes: extractAnimationKeyframes(css, viewport),
    fonts: extractFontFaces(css, 'https://example.test/css/main.css', viewport),
  };
}

test('large stylesheets preserve scalar rules, keyframes and font faces across UTF-16 vector boundaries', () => {
  const source = String.raw`
    @layer app;
    @media (min-width: 1px) {
      .😀[data-x=";}"]::before, .a\{b { content: "引號\";}"; color: red }
      @keyframes slide { from { transform: translateX(10px) } 50%, to { color: green } }
      @font-face { font-family: '例字'; src: url('font;}.woff2') }
    }
    @layer app { #last { content: '}'; color: blue } }
    .unclosed { color: green`;
  const viewport = {width: 400, height: 300};
  const expected = parsed(source, viewport);
  expect(expected.rules.length).toBe(4);
  expect(expected.keyframes.get('slide').length).toBe(3);
  expect(expected.fonts.length).toBe(1);
  for (let offset = 0; offset < 16; offset++) {
    expect(parsed(padding + ' '.repeat(offset) + source, viewport)).toEqual(expected);
  }
});

test('nested stylesheet parsing in a viewport getter preserves the outer input', () => {
  const outer = '@media screen { .outer {color:red} } .tail {color:blue}';
  const viewport = { get viewportWidth() {
    expect(parseStyleSheet(padding + '.inner{}').map(rule => rule.selector)).toEqual(['.inner']);
    return 400;
  }};
  expect(parsed(padding + outer, viewport)).toEqual(parsed(outer, {width:400}));
});

test('bounds and synchronous exceptions preserve the next scan', () => {
  const scannerFor = text => scanStyleSheet(text, scanner => scanner);
  const scalar = scannerFor('');
  // More UTF-16 units than fit in the bounded 8 MiB scratch buffer.
  expect(scannerFor(' '.repeat(4 * 1024 * 1024))).toBe(scalar);
  const sheet = padding + 'a{color:green}';
  const scanner = scannerFor(sheet);
  const list = padding + 'a,b{}';
  expect(scanStyleSheet(list, scanner => scanner.findTopLevel(list, ',', 0, list.length))).toBe(padding.length + 1);
  expect(() => scanStyleSheet(sheet, () => { throw Error('parse interrupted'); })).toThrow('parse interrupted');
  expect(scannerFor(sheet)).toBe(scanner);
  expect(parseStyleSheet(sheet)[0].declarations.get('color').value).toBe('green');
});

test('large CSS still scans when WebAssembly is unavailable', async () => {
  // Use a fresh module instance so the other tests can still exercise SIMD.
  const {scanStyleSheet: scan} = await import('../lib/style/css-scanner.js?without-wasm');
  const original = globalThis.WebAssembly;
  const sheet = padding + '.fallback{}';
  try {
    globalThis.WebAssembly = undefined;
    const scalar = scan('', scanner => scanner);
    scan(sheet, scanner => {
      expect(scanner).toBe(scalar);
      expect(scanner.matchingBrace(sheet, sheet.length - 2, sheet.length)).toBe(sheet.length - 1);
    });
  } finally {
    globalThis.WebAssembly = original;
  }
});

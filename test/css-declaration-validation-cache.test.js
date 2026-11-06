import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';
import { cacheSpecifiedValue } from '../lib/style/css-specified-value-cache.js';

test('repeated resolved syntax still computes lengths, colors and relative weights in each context', () => {
  const { document, window } = parseHTMLDocument('<main id="parent"><div id="a"></div><div id="b"></div></main>');
  try {
    const parent = document.getElementById('parent');
    const a = document.getElementById('a'), b = document.getElementById('b');
    const common = 'width:2em;height:10vh;margin-left:1rem;padding:1em;'
      + 'border:1px solid currentcolor;box-shadow:1em 0 currentcolor;background:currentcolor;font-weight:bolder;';
    a.style.cssText = common + 'font-size:10px;color:red';
    b.style.cssText = common + 'font-size:20px;color:blue';
    for (const [rootSize, height, parentWeight, weight] of [[12, 200, 300, 400], [24, 400, 550, 900], [12, 200, 300, 400]]) {
      document.documentElement.style.fontSize = `${rootSize}px`;
      parent.style.fontWeight = String(parentWeight);
      const styles = new StyleEngine().compute(document, [], { width: 800, height });
      for (const [element, size, color] of [[a, 10, 'rgba(255, 0, 0, 1)'], [b, 20, 'rgba(0, 0, 255, 1)']]) {
        const style = styles.get(element);
        expect(style).toMatchObject({ width: size * 2, height: height / 10, fontWeight: weight, backgroundColor: color });
        expect(style.margin[3]).toBe(rootSize);
        expect(style.padding).toEqual([size, size, size, size]);
        expect(style.borderColors).toEqual([color, color, color, color]);
        expect(style.boxShadow[0]).toMatchObject({ x: size, y: 0, color });
      }
    }
  } finally { window.happyDOM.close(); }
});

test('cached validation follows variable changes and pending longhands without reviving older declarations', () => {
  const { document, window } = parseHTMLDocument('<main style="font-weight:550"><div id="box"></div></main>');
  try {
    const box = document.getElementById('box');
    box.style.cssText = 'border:var(--edge);border-left-width:7px;overflow:var(--scroll);'
      + 'padding:var(--pad);width:99px;width:var(--size);font-weight:var(--weight);';
    const set = (values) => {
      for (const [name, value] of Object.entries(values)) box.style.setProperty(`--${name}`, value);
      return new StyleEngine().compute(document).get(box);
    };
    for (let repeat = 0; repeat < 3; repeat++) {
      const valid = set({ edge: '2px solid red', scroll: 'scroll hidden', pad: '2px 4px', size: '25px', weight: 'bolder' });
      expect(valid).toMatchObject({ width: 25, fontWeight: 900, overflowValueX: 'scroll', overflowValueY: 'hidden' });
      expect(valid.borderWidths).toEqual([2, 2, 2, 7]);
      expect(valid.padding).toEqual([2, 4, 2, 4]);

      const invalid = set({ edge: 'invalid', scroll: 'invalid', pad: '-1px', size: 'none', weight: '1001' });
      expect(invalid).toMatchObject({ width: 'auto', fontWeight: 550, overflowValueX: 'visible', overflowValueY: 'visible' });
      expect(invalid.borderWidths).toEqual([0, 0, 0, 0]);
      expect(invalid.borderSpecifiedWidths[3]).toBe(7);
      expect(invalid.padding).toEqual([0, 0, 0, 0]);
    }
    // The same resolved string can be legal for one property and invalid for
    // another; validation must include the property in its key.
    box.style.cssText = '--value:none;width:var(--value);max-width:var(--value);--number:2px;padding-top:var(--number);font-weight:var(--number)';
    const differentProperties = new StyleEngine().compute(document).get(box);
    expect(differentProperties).toMatchObject({ width: 'auto', maxWidth: 'none', fontWeight: 550 });
    expect(differentProperties.padding[0]).toBe(2);
  } finally { window.happyDOM.close(); }
});

test('original-string/unset validation entries use bounded, unambiguous keys and bypass long input', () => {
  let calls = 0;
  const validate = cacheSpecifiedValue((name, value) => {
    calls++;
    return name === 'width' && value === 'none' ? 'unset' : value;
  });
  expect(validate('width', 'none', false)).toBe('unset');
  expect(validate('max-width', 'none', false)).toBe('none');
  expect(validate('width', 'none', false)).toBe('unset');
  expect(calls).toBe(2);
  expect(validate('a', '1\0b', false)).toBe('1\0b');
  expect(validate('a1', '\0b', false)).toBe('\0b');
  expect(validate('a', '1\0b', false)).toBe('1\0b');
  expect(calls).toBe(4);
  for (let i = 0; i < 512; i++) validate('width', `${i}px`, false);
  validate('width', '511px', false);
  expect(calls).toBe(516);
  validate('width', 'none', false);
  expect(calls).toBe(517); // The old entry was evicted, not retained forever.
  const large = 'x'.repeat(513);
  expect(validate('font-family', large, false)).toBe(large);
  expect(validate('font-family', large, false)).toBe(large);
  expect(calls).toBe(519);
});

import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {computeElementStyle, StyleEngine} from '../lib/style/computed-style.js';

// Feed authored declarations directly, before parseDeclarations canonicalizes
// them. A long CSS comment preserves their syntax while exceeding the shared
// cache's input limit, providing the same normalization through its bypass.
const bypass = `/*${'uncached '.repeat(70)}*/`;
const declarations = (entries, uncached = false) => new Map(entries.map(([name, value], order) => [name, {
  name, value: uncached ? bypass + value : value, specificity: 1, order, layer: Infinity,
}]));

test('cached property normalization equals the uncached chain across font, inheritance and direction', () => {
  const {document, window} = parseHTMLDocument('<main><div></div></main>');
  try {
    const element = document.querySelector('div'), parent = element.parentElement;
    const values = [
      ['font-weight', 'bolder'], ['font-family', '"Case Font", SANS-SERIF'],
      ['align-items', 'SAFE CENTER'], ['row-gap', '1em'], ['grid-column-gap', '2em'],
      ['will-change', 'opacity, transform'], ['margin-inline', '1em 2em'],
      ['padding-inline', '2em 3em'], ['inset-inline', '3em 4em'],
      ['border', '0.1em SOLID currentcolor'], ['border-start-start-radius', '1em 2em'],
      ['background-size', '2em 3em'], ['inline-size', '4em'], ['border-spacing', '1em 2em'],
      ['overflow-inline', 'SCROLL'], ['overflow-block', 'HIDDEN'],
      ['box-shadow', '1em 2em currentcolor'], ['opacity', 'calc(50% + 25%)'],
      ['flex-grow', 'calc(1 + 2)'], ['position', 'RELATIVE'], ['word-wrap', 'BREAK-WORD'],
      ['text-decoration-style', 'DASHED'], ['animation-direction', 'ALTERNATE'],
    ];
    for (const [fontSize, parentWeight, direction, color] of [
      [10, 300, 'ltr', 'red'], [20, 550, 'rtl', 'blue'], [10, 300, 'ltr', 'red'],
    ]) {
      const parentStyle = computeElementStyle(parent, null, declarations([
        ['font-size', `${fontSize}px`], ['font-weight', String(parentWeight)], ['color', color], ['direction', direction],
      ]));
      const warm = () => computeElementStyle(element, parentStyle, declarations(values));
      warm();
      const cached = warm();
      const uncached = computeElementStyle(element, parentStyle, declarations(values, true));
      expect(cached).toEqual(uncached);
      expect(cached).toMatchObject({fontSize, fontWeight: parentWeight === 300 ? 400 : 900,
        direction, width: 4 * fontSize, rowGap: fontSize, columnGap: 2 * fontSize,
        opacity: 0.75, flexGrow: 3, overflowValueX: 'scroll', overflowValueY: 'hidden'});
      expect(cached.margin).toEqual(direction === 'ltr' ? [0, 2 * fontSize, 0, fontSize] : [0, fontSize, 0, 2 * fontSize]);
      expect(cached.padding).toEqual(direction === 'ltr' ? [0, 3 * fontSize, 0, 2 * fontSize] : [0, 2 * fontSize, 0, 3 * fontSize]);
      expect(cached[direction === 'ltr' ? 'borderTopLeftRadius' : 'borderTopRightRadius']).toEqual([fontSize, 2 * fontSize]);
    }
  } finally {window.happyDOM.close();}
});

test('cached normalization preserves invalid syntax, CSS-wide values and property aliases', () => {
  const {document, window} = parseHTMLDocument('<main><div></div></main>');
  try {
    const element = document.querySelector('div'), parent = element.parentElement;
    const context = computeElementStyle(parent, null, declarations([
      ['font-size', '18px'], ['font-weight', '550'], ['margin-left', '7px'], ['width', '90px'],
    ]));
    const cases = [
      [['font-weight', 'inherit'], ['inline-size', 'inherit'], ['margin-left', 'inherit'], ['row-gap', 'initial']],
      [['font-weight', '1001'], ['inline-size', 'none'], ['padding-top', '-1px'], ['row-gap', 'auto']],
      [['grid-gap', '2em 3em'], ['overflow-inline', 'CLIP'], ['overflow-block', 'VISIBLE'], ['word-wrap', 'NORMAL']],
      [['font-family', 'inherit'], ['margin-block', 'unset'], ['align-items', 'initial'], ['opacity', 'inherit']],
    ];
    for (let repeat = 0; repeat < 3; repeat++) for (const entries of cases) {
      const cached = computeElementStyle(element, context, declarations(entries));
      const uncached = computeElementStyle(element, context, declarations(entries, true));
      expect(cached).toEqual(uncached);
    }
    const inherited = computeElementStyle(element, context, declarations(cases[0]));
    expect(inherited).toMatchObject({fontWeight:550, width:90});
    expect(inherited.margin[3]).toBe(7);
    const invalid = computeElementStyle(element, context, declarations(cases[1]));
    expect(invalid).toMatchObject({fontWeight:550, width:'auto', rowGapNormal:true});
    expect(invalid.padding[0]).toBe(0);
  } finally {window.happyDOM.close();}
});

test('warm property syntax still follows viewport, rem, font aliases and substituted variables', () => {
  const {document, window} = parseHTMLDocument('<main id="parent"><div id="box"></div></main>');
  try {
    const parent = document.getElementById('parent'), box = document.getElementById('box');
    // Exercise the authored font-width alias directly: Happy DOM's CSSOM
    // declaration store does not retain that name in style.cssText yet.
    const sheets = ['#box{font-width:150%}'];
    box.style.cssText = 'font-size:10px;width:10vw;height:10vh;margin-left:1rem;'
      + 'padding-inline:var(--pad);grid-gap:var(--gap);border-start-start-radius:1em 2em;';
    for (const [width, height, rootSize, direction, padding, gap] of [
      [400, 200, 12, 'ltr', '1em 2em', '2em'],
      [800, 400, 24, 'rtl', '3em 4em', '4em'],
      [400, 200, 12, 'ltr', '1em 2em', '2em'],
    ]) {
      document.documentElement.style.fontSize = `${rootSize}px`;
      parent.style.direction = direction;
      parent.style.setProperty('--pad', padding);parent.style.setProperty('--gap', gap);
      const computed = new StyleEngine().compute(document, sheets, {width, height}).get(box);
      expect(computed).toMatchObject({width:width / 10, height:height / 10, fontStretch:150, direction,
        rowGap:parseFloat(gap) * 10, columnGap:parseFloat(gap) * 10});
      expect(computed.margin[3]).toBe(rootSize);
      const [start, end] = padding.split(' ').map(value => parseFloat(value) * 10);
      expect(computed.padding).toEqual(direction === 'ltr' ? [0,end,0,start] : [0,start,0,end]);
      expect(computed[direction === 'ltr' ? 'borderTopLeftRadius' : 'borderTopRightRadius']).toEqual([10,20]);
    }
  } finally {window.happyDOM.close();}
});

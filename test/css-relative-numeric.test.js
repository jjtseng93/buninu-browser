import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeFontWeight,computedFontWeight} from '../lib/style/font-weight-values.js';
import {animationEnumValue} from '../lib/style/animation-enum-values.js';
import {typedCSSNumericValue,absoluteCSSNumericValue} from '../lib/style/animation-numeric-values.js';
import {parseCSSComponentValues} from '../lib/style/css-value-tokens.js';
import {parseCanvasFont} from '../lib/renderer/canvas-text.js';
import {serializeDeferredCSSMath} from '../lib/style/css-math-serialization.js';

const token=value=>parseCSSComponentValues(value).tokens[0];

test('typed relative math validates without replacing an unknown basis by zero',()=>{
  for(const text of ['calc(sign(1rem - 1px) * 400)','calc(1em / 1px)','calc(sign(2cqw - 10px))']) {
    expect(supportsDeclaration('font-weight',text)).toBeTrue();
    expect(absoluteCSSNumericValue(token(text))).toBeNull();
    expect(Number.isNaN(typedCSSNumericValue(token(text)).value)).toBeTrue();
    expect(computedFontWeight(text)).toBeUndefined();
    expect(computedFontWeight(text,400,()=>NaN)).toBeUndefined();
  }
  for(const text of ['calc(1rem + 1)','calc(1rem * 2)','calc(sign(1rem + 2))','calc(1rem / 1s)'])
    expect(supportsDeclaration('font-weight',text)).toBeFalse();
  expect(computedFontWeight('calc(1em / 1px)',400,()=>24)).toBe(24);
  expect(computedFontWeight('calc(0em / 0px)',400,()=>24)).toBe(1);
  expect(normalizeFontWeight('font-weight','calc('+'('.repeat(140)+'1em / 1px'+')'.repeat(140)+')')).toBeNull();
});

test('relative font calculations serialize symbolic sums and products in canonical order',()=>{
  const cases=[
    ['calc(100 + (sign(20cqw - 10px) * 5))','calc(100 + (5 * sign(20cqw - 10px)))'],
    ['calc(sign(1rem - 1px) * 400)','calc(400 * sign(-1px + 1rem))'],
    ['calc((1em / 1px) + 5)','calc(5 + (1em / 1px))'],
    ['calc(sign(1em - 2em) * (2 * 50))','calc(100 * sign(-1em))'],
    ['calc(100 + (20 + (1em / 1px)))','calc(120 + (1em / 1px))'],
    ['calc(5 * (2em / 1px))','calc(10em / 1px)'],
  ];
  for(const [source,expected] of cases) {
    const text=normalizeFontWeight('font-weight',source);
    expect(text).toBe(expected);
    expect(normalizeFontWeight('font-weight',text)).toBe(text);
  }
  // Reordering must preserve subtraction, division, nested groups and clamp.
  const values=['calc(10 - (1em / 1px))','calc(100 / (1em / 1px))',
    'calc(50 - ((1em / 1px) - 2))','calc(sign(1em - 20px) * -5 + 400)',
    'clamp(10, calc(1em / 1px), 100)','calc((20 + 1em / 1px) / 2)',
    'calc(sign(1em - 20px) + (1em / 1px) * 2)'];
  for(const source of values)for(const size of [1,16,20,32,100]) {
    const resolved=unit=>unit==='1em'?size:NaN;
    const before=typedCSSNumericValue(token(source),resolved);
    const after=typedCSSNumericValue(token(normalizeFontWeight('font-weight',source)),resolved);
    expect(after).toEqual(before);
  }
});

test('the cascade computes numeric math with final font size, root size and viewport',()=>{
  const {window,document}=parseHTMLDocument('<!doctype html><html style="font-size:20px"><body><div id=x></div></body></html>');
  const x=document.getElementById('x'),engine=new StyleEngine();
  const compute=()=>{engine.compute(document,[],{width:1000,height:600});return engine.get(x);};
  try {
    for(const [css,expected] of [
      ['font-weight:calc(sign(1rem - 1px) * 10)',10],
      ['font-weight:calc(sign(1rem - 1px) * -10000)',1],
      ['font-weight:calc(sign(1rem - 1px) * 10000)',1000],
      ['font-weight:calc(1em / 1px);font-size:24px',24],
      ['font-weight:calc(1rem / 1px);font-size:24px',20],
      ['font-weight:calc(10vw / 1px)',100],
      ['font-weight:calc(10vh / 1px)',60],
      ['font-weight:calc(10vmin / 1px)',60],
      ['font-weight:calc(10vmax / 1px)',100],
      ['--w:calc(1em / 1px);font-weight:var(--w);font-size:30px',30],
      ['font:calc(1em / 1px) 32px serif',32],
    ]) {x.style.cssText=css;expect(compute().fontWeight).toBe(expected);}
    x.style.cssText='font-weight:calc(1rem / 1px)';expect(compute().fontWeight).toBe(20);
    document.documentElement.style.fontSize='30px';
    engine.compute(document,[],{width:1000,height:600},new Set(),new Set([document.documentElement]));
    expect(engine.get(x).fontWeight).toBe(30);
    x.style.fontWeight='calc(1ex / 1px)';expect(compute().fontWeight).toBe(400);
    x.style.fontWeight='calc(sign(2cqw - 10px) * 500)';expect(compute().fontWeight).toBe(400);
    x.style.cssText='font:700 24px serif;font-weight:calc(1cqw / 1px)';
    expect(compute().fontWeight).toBe(400);
  }finally{window.happyDOM.close();}
});

test('animation math resolves available relative units, including inherited computed values',()=>{
  const {window,document}=parseHTMLDocument('<!doctype html><html style="font-size:20px"><body><div id=p><div id=x></div></div></body></html>');
  const p=document.getElementById('p'),x=document.getElementById('x'),engine=new StyleEngine();
  try {
    p.style.cssText='font-size:24px;animation-duration:calc(1s * (1em / 1px));animation-delay:calc(sign(1rem - 30px) * 2s);animation-iteration-count:calc(10vw / 1px)';
    x.style.cssText='font-size:12px;animation-duration:inherit;animation-delay:inherit;animation-iteration-count:inherit';
    engine.compute(document,[],{width:800,height:600});
    for(const node of [p,x])expect(['animation-duration','animation-delay','animation-iteration-count'].map(name=>animationEnumValue(engine.get(node),name))).toEqual(['24s','-2s','80']);
    // Missing query-container geometry must remain unresolved, not use the
    // viewport and silently choose the opposite sign of this expression.
    x.style.animationDelay='calc(sign(2cqw - 10px) * 5s)';engine.compute(document);
    expect(animationEnumValue(engine.get(x),'animation-delay')).toBe('calc(sign(2cqw - 10px) * 5s)');
  }finally{window.happyDOM.close();}
});

test('canvas font shorthand resolves its available bases and rejects incomplete text styles',()=>{
  expect(parseCanvasFont('calc(1em / 1px) 24px serif',16,20).fontWeight).toBe(24);
  expect(parseCanvasFont('calc(1rem / 1px) 24px serif',16,20).fontWeight).toBe(20);
  expect(parseCanvasFont('calc(sign(1rem - 1px) * 700) 24px serif',16,20).fontWeight).toBe(700);
  expect(parseCanvasFont('calc(1cqw / 1px) 24px serif',16,20)).toBeNull();
  expect(parseCanvasFont('calc(1vw / 1px) 24px serif',16,20)).toBeNull();
});

test('symbolic serialization preserves signed zero through arithmetic and repeated writes',()=>{
  const cases=['calc(1 / sign(0em * -1))','calc(1 / sign(-0em))','calc(1 / sign(0em / -1))',
    'calc(1 / sign(0em - 0em))','calc(1 / (-0em + min(-0em, -0px)))',
    'calc(1 / (sign(-0em) + sign(-0em)))','calc(0px / min(-0em,0px))',
    'calc(1 / (min(0em,-0px) * 1))','calc(sign(-0em) * 0)','calc(sign(-0em) / -1)'];
  for(const input of cases) {
    const output=serializeDeferredCSSMath(token(input));
    const before=typedCSSNumericValue(token(input),()=>16),after=typedCSSNumericValue(token(output),()=>16);
    expect(Object.is(after.value,before.value)).toBeTrue();
    expect(serializeDeferredCSSMath(token(output))).toBe(output);
  }
});

test('negative-zero font math survives CSSOM, the stylesheet cascade and canvas font parsing',()=>{
  const {window,document}=parseHTMLDocument('<!doctype html><div id=x></div>');
  const x=document.getElementById('x'),engine=new StyleEngine();
  try {
    for(const [value,expected] of [
      ['calc(1 / sign(0em * -1))',1],['calc(1 / sign(-0em))',1],
      ['calc(1 / sign(0em / -1))',1],['calc(1 / (sign(-0em) + sign(-0em)))',1],
      ['calc(1 / sign(min(0em, -0px)))',1],['calc(1 / sign(0em - 0em))',1000],
    ]) {
      x.style.fontWeight=value;
      const serialized=x.style.fontWeight,css=x.style.cssText;
      expect(serialized).not.toBe('');
      engine.compute(document);expect(engine.get(x).fontWeight).toBe(expected);
      x.style.cssText=css;
      expect(x.style.fontWeight).toBe(serialized);
      engine.compute(document);expect(engine.get(x).fontWeight).toBe(expected);
      x.style.cssText='';
      engine.compute(document,[`#x { font-weight:${value} }`]);
      expect(engine.get(x).fontWeight).toBe(expected);
      expect(parseCanvasFont(`${value} 24px serif`).fontWeight).toBe(expected);
    }
  }finally{window.happyDOM.close();}
});

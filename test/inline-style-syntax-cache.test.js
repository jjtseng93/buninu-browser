import {afterAll, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {computeElementStyle, StyleEngine} from '../lib/style/computed-style.js';

// An uncached copy is an oracle for pending CSSOM provenance and ordering. A
// counted copy also verifies that unchanged attributes actually avoid parsing,
// without timing thresholds or adding diagnostics to the production module.
const moduleURL = new URL('../lib/style/computed-style.js', import.meta.url);
const source = readFileSync(moduleURL, 'utf8');
const limit = 'const MAX_CACHED_INLINE_SOURCE = 64 * 1024;';
const parser = 'export function parseDeclarations(source,{fontFace=false}={}) {';
if (!source.includes(limit) || !source.includes(parser)) throw Error('Update the inline syntax cache oracle');
const absolute = source
  .replace(/from\s+(["'])(\.[^"']+)\1/g, (_match,_quote,specifier) => `from ${JSON.stringify(new URL(specifier,moduleURL).href)}`)
  .replace(/^import\s+(["'])(\.[^"']+)\1/gm, (_match,_quote,specifier) => `import ${JSON.stringify(new URL(specifier,moduleURL).href)}`);
const directory = mkdtempSync(join(tmpdir(), 'buninu-inline-syntax-'));
async function variant(name, uncached = false) {
  const path = join(directory, name + '.mjs');
  writeFileSync(path, 'export let declarationParseCalls = 0;\n' + absolute.replace(parser,
    `${parser}\ndeclarationParseCalls++;`)
    .replace(limit, uncached ? 'const MAX_CACHED_INLINE_SOURCE = 0;' : limit));
  return import(pathToFileURL(path).href);
}
const counted = await variant('counted'), reference = await variant('uncached', true);
afterAll(() => rmSync(directory, {recursive:true, force:true}));

test('inline syntax is parsed once per unchanged attribute and invalidates on all attribute writes', () => {
  const f = parseHTMLDocument('<div style="width:31px;color:red"></div>'), box = f.document.querySelector('div');
  try {
    let calls = counted.declarationParseCalls;
    expect(counted.computeElementStyle(box).width).toBe(31);
    expect(counted.declarationParseCalls - calls).toBe(1);
    for (let i=0; i<10; i++) expect(counted.computeElementStyle(box).width).toBe(31);
    expect(counted.declarationParseCalls - calls).toBe(1);
    for (const write of [
      () => box.setAttribute('style', 'width:41px'),
      () => box.getAttributeNode('style').value = 'width:42px',
      () => box.style.width = '43px',
      () => box.setAttributeNS(null, 'style', 'width:44px'),
    ]) {
      write(); calls = counted.declarationParseCalls;
      const actual = counted.computeElementStyle(box);
      expect(actual).toEqual(reference.computeElementStyle(box));
      counted.computeElementStyle(box);
      expect(counted.declarationParseCalls - calls).toBe(1);
    }
    box.removeAttribute('style');
    expect(counted.computeElementStyle(box).width).toBe('auto');
    box.setAttribute('style', 'width:44px'); calls = counted.declarationParseCalls;
    counted.computeElementStyle(box);
    expect(counted.declarationParseCalls - calls).toBe(1);
    // Oversized text remains supported but is not retained in the weak cache.
    box.setAttribute('style', ' '.repeat(65536) + 'width:45px'); calls = counted.declarationParseCalls;
    expect(counted.computeElementStyle(box).width).toBe(45);
    expect(counted.computeElementStyle(box).width).toBe(45);
    expect(counted.declarationParseCalls - calls).toBe(2);
  } finally {f.window.happyDOM.close();}
});

test('cached inline syntax still resolves inherited variables and relative dimensions on every pass', () => {
  const f = parseHTMLDocument('<main><div style="width:10vw;padding:var(--space);color:inherit;font-weight:bolder"></div></main>');
  const parent=f.document.querySelector('main'), box=f.document.querySelector('div'), engine=new StyleEngine();
  try {
    for (const [width, size, color, weight] of [[400,10,'red',300],[800,20,'blue',550],[400,10,'red',300]]) {
      parent.style.cssText=`font-size:${size}px;color:${color};font-weight:${weight};--space:1em 2em`;
      engine.compute(f.document, [], {width,height:300});
      const actual=engine.get(box), expected=new reference.StyleEngine().compute(f.document,[],{width,height:300}).get(box);
      expect(actual).toEqual(expected);
      expect(actual.width).toBe(width / 10);
      expect(actual.padding).toEqual([size,2*size,size,2*size]);
      expect(actual.fontWeight).toBe(weight === 300 ? 400 : 900);
    }
  } finally {f.window.happyDOM.close();}
});

test('equal inline cssText keeps live border provenance and loses it on direct attribute reparsing', () => {
  const f=parseHTMLDocument('<div id="box"></div>'), box=f.document.querySelector('div'), engine=new StyleEngine();
  const sheets=['#box{--first:1px solid red;--second:7px dashed blue}'];
  const read=() => {
    const actual=engine.compute(f.document,sheets).get(box);
    expect(actual).toEqual(new reference.StyleEngine().compute(f.document,sheets).get(box));
    return actual;
  };
  try {
    box.style.cssText='border:var(--first);border-left-width:5px';
    const text=box.style.cssText;
    expect(read().borderWidths).toEqual([1,1,1,5]);
    box.style.border='var(--second)';box.style.borderLeftWidth='5px';
    expect(box.style.cssText).toBe(text);
    expect(read().borderWidths).toEqual([7,7,7,5]);
    box.setAttribute('style',text);
    expect(read().borderWidths).toEqual([0,0,0,0]);
    // Reintroducing private provenance with the same text must work again.
    box.style.border='var(--first)';box.style.borderLeftWidth='5px';
    expect(box.style.cssText).toBe(text);
    expect(read().borderWidths).toEqual([1,1,1,5]);
  } finally {f.window.happyDOM.close();}
});

test('overflow restoration cannot mutate cached declaration order or retain stale source metadata', () => {
  const f=parseHTMLDocument('<div id="box"></div>'), box=f.document.querySelector('div');
  const sheets=['#box{--first:auto hidden;--second:auto clip}'];
  const read=() => {
    const actual=new StyleEngine().compute(f.document,sheets).get(box);
    expect(actual).toEqual(new reference.StyleEngine().compute(f.document,sheets).get(box));
    return [actual.overflowValueX, actual.overflowValueY];
  };
  try {
    box.style.cssText='padding:3px;all:initial;padding-left:4px;overflow:var(--first);overflow-x:scroll';
    const text=box.style.cssText;
    expect(read()).toEqual(['scroll','hidden']);
    box.style.overflow='var(--second)';box.style.overflowX='scroll';
    expect(box.style.cssText).toBe(text);
    expect(read()).toEqual(['scroll','clip']);
    box.setAttribute('style',text);
    expect(read()).toEqual(['scroll','auto']);
    box.style.overflow='var(--first)';box.style.overflowX='scroll';
    expect(box.style.cssText).toBe(text);
    expect(read()).toEqual(['scroll','hidden']);
    // Direct callers use the same syntax cache but keep supplied cascade maps
    // and their declaration records isolated from any pending-axis edits.
    const author=new Map([['width',{name:'width',value:'8px',order:1}]]);
    const original=author.get('width');
    expect(computeElementStyle(box,null,author)).toEqual(reference.computeElementStyle(box,null,author));
    expect(author.get('width')).toBe(original);
    expect(original).toEqual({name:'width',value:'8px',order:1});
  } finally {f.window.happyDOM.close();}
});

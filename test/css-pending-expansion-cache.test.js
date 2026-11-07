import {afterAll, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, computeElementStyle, parseDeclarations} from '../lib/style/computed-style.js';

// Compare complete computed output with reuse disabled, keeping variable
// substitution, expansion, cascade and computed-value conversion identical.
const moduleURL = new URL('../lib/style/computed-style.js', import.meta.url);
const source = readFileSync(moduleURL, 'utf8');
const cacheLimit = 'const MAX_PENDING_SHORTHANDS = 16;';
if (!source.includes(cacheLimit)) throw new Error('The pending-expansion oracle needs updating');
const referenceSource = source.replace(cacheLimit, 'const MAX_PENDING_SHORTHANDS = 0;')
  .replace(/from\s+(["'])(\.[^"']+)\1/g, (_match,_quote,specifier) =>
    `from ${JSON.stringify(new URL(specifier,moduleURL).href)}`)
  .replace(/^import\s+(["'])(\.[^"']+)\1/gm, (_match,_quote,specifier) =>
    `import ${JSON.stringify(new URL(specifier,moduleURL).href)}`);
const directory = mkdtempSync(join(tmpdir(),'buninu-pending-expansion-'));
const referencePath = join(directory,'computed-style-reference.mjs');
writeFileSync(referencePath, referenceSource);
const reference = await import(pathToFileURL(referencePath).href);
afterAll(() => rmSync(directory,{recursive:true,force:true}));

function compare(document, sheets, elements, viewport = {}) {
  const actual = new StyleEngine().compute(document,sheets,viewport);
  const expected = new reference.StyleEngine().compute(document,sheets,viewport);
  for (const element of elements) {
    expect(actual.get(element)).toEqual(expected.get(element));
    for (const pseudo of ['before','after'])
      expect(actual.getPseudo(element,pseudo)).toEqual(expected.getPseudo(element,pseudo));
  }
  return actual;
}

test('shared pending expansions keep relative lengths and currentcolor local to each element and pass', () => {
  const f = parseHTMLDocument('<div id="a" class="item"></div><div id="b" class="item"></div>');
  const a=f.document.getElementById('a'), b=f.document.getElementById('b');
  const sheets=['.item{border:var(--edge);border-left-width:var(--left);padding:var(--space);border-radius:var(--radii)}'
    + '.item::before{content:"BEFORE";border:var(--edge);font-size:5px}'];
  try {
    for (const [size,height] of [[10,200],[20,400],[10,200]]) {
      a.style.cssText=`--edge:1em solid currentcolor;--left:2em;--space:1em 2vh;--radii:1em 2em;font-size:${size}px;color:red`;
      b.style.cssText=`--edge:1em solid currentcolor;--left:2em;--space:1em 2vh;--radii:1em 2em;font-size:${size*2}px;color:blue`;
      const styles=compare(f.document,sheets,[a,b],{width:800,height});
      for (const [element,font,color] of [[a,size,'rgba(255, 0, 0, 1)'],[b,size*2,'rgba(0, 0, 255, 1)']]) {
        expect(styles.get(element).borderWidths).toEqual([font,font,font,font*2]);
        expect(styles.get(element).borderColors).toEqual(Array(4).fill(color));
        expect(styles.get(element).padding).toEqual([font,height*.02,font,height*.02]);
        expect(styles.getPseudo(element,'before').borderWidths).toEqual([5,5,5,5]);
      }
    }
  } finally {f.window.happyDOM.close();}
});

test('invalid substitutions still unset only their surviving longhands and never revive older values', () => {
  const f=parseHTMLDocument('<div id="box"></div>'),box=f.document.getElementById('box');
  try {
    for (const edge of ['2px solid red','nonsense','var(--cycle)','4px dotted blue','nonsense']) {
      const sheets=[`#box{--edge:${edge};--cycle:var(--cycle);border:9px solid green;border:var(--edge);border-left-width:7px}`];
      const style=compare(f.document,sheets,[box]).get(box);
      if (edge==='nonsense'||edge==='var(--cycle)') {
        expect(style.borderWidths).toEqual([0,0,0,0]);
        expect(style.borderSpecifiedWidths).toEqual([3,3,3,7]);
      } else expect(style.borderWidths).toEqual([parseInt(edge),parseInt(edge),parseInt(edge),7]);
    }
  } finally {f.window.happyDOM.close();}
});

test('expansion reuse preserves source order, important layers, all resets and distinct shorthand names', () => {
  const f=parseHTMLDocument('<div id="box"></div>'),box=f.document.getElementById('box');
  try {
    const definitions='--edge:2px solid red;--side:6px dotted blue;--four:1px 2px 3px 4px;--pair:5px 9px;';
    const cases=[
      ['border:var(--edge);border-left:var(--side)',[2,2,2,6]],
      ['border-left:var(--side);border:var(--edge)',[2,2,2,2]],
      ['border:var(--edge);all:initial;border-left:var(--side)',[0,0,0,6]],
      ['all:initial;border:var(--edge);border-left-width:7px!important',[2,2,2,7]],
      ['border:var(--edge)!important;border-left:var(--side)',[2,2,2,2]],
    ];
    for (const [css,widths] of cases) {
      const sheets=[`#box{${definitions}${css};margin:var(--four);padding:var(--four);inset:var(--four);gap:var(--pair)}`];
      const style=compare(f.document,sheets,[box]).get(box);
      expect(style.borderWidths).toEqual(widths);
      expect(style.margin).toEqual([1,2,3,4]);expect(style.padding).toEqual([1,2,3,4]);
      expect(style.inset).toEqual([1,2,3,4]);expect([style.rowGap,style.columnGap]).toEqual([5,9]);
    }
    for (const order of ['first,second','second,first']) {
      compare(f.document,[`@layer ${order};`,
        `@layer first{#box{${definitions}border:var(--edge)!important;border-left-width:7px}}`,
        `@layer second{#box{${definitions}border:var(--side)!important;all:initial}}`,
      ],[box]);
    }
  } finally {f.window.happyDOM.close();}
});

test('all supported pending syntax paths match uncached expansion, including large inputs', () => {
  const f=parseHTMLDocument('<div id="box"></div>'),box=f.document.getElementById('box');
  const cases=[
    ['border','1px solid currentcolor'],['border-width','1em 2px'],
    ['border-color','currentcolor red blue green'],['border-style','solid dashed dotted double'],
    ['border-radius','1px 2px / 3px 4px'],['margin','1px auto 3px'],['padding','1px 2px'],
    ['inset','1px auto 3px'],['gap','normal 2em'],['place-content','center start'],
    ['place-items','center stretch'],['place-self','start end'],
    ['background','red url(example.png) no-repeat center / 10px 20px'],
    ['border',`1px${' '.repeat(600)}solid red`],['border','invalid'.repeat(100)],
  ];
  try {
    for (const [name,value] of cases) {
      const declarations=parseDeclarations(`${name}:var(--value)`);
      const custom=new Map([['--value',value]]);
      expect(computeElementStyle(box,null,declarations,custom)).toEqual(
        reference.computeElementStyle(box,null,declarations,custom));
    }
    // More than sixteen distinct resolved expansions in one computation:
    // saturation may only disable reuse, never drop any declaration.
    const declarations=new Map();
    for (const [prefix,properties] of [
      ['border',['border-top-width','border-right-width','border-bottom-width','border-left-width',
        'border-top-style','border-right-style','border-bottom-style','border-left-style',
        'border-top-color','border-right-color','border-bottom-color','border-left-color']],
      ['margin',['margin-top','margin-right','margin-bottom','margin-left']],
      ['padding',['padding-top','padding-right','padding-bottom','padding-left']],
    ]) for (const name of properties) {
      const order=declarations.size+1;
      declarations.set(name,{name,pendingBorder:prefix,value:prefix==='border'?`${order}px solid red`:`${order}px`,order,specificity:1});
    }
    const actual=computeElementStyle(box,null,declarations);
    expect(actual).toEqual(reference.computeElementStyle(box,null,declarations));
    expect(actual.margin).toEqual([13,14,15,16]);expect(actual.padding).toEqual([17,18,19,20]);
  } finally {f.window.happyDOM.close();}
});

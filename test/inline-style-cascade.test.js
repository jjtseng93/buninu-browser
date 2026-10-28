import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { computeElementStyle, parseDeclarations, StyleEngine } from '../lib/style/computed-style.js';

test('inline importance and variables reach principal styles without leaking into pseudos', () => {
  const { document, window } = parseHTMLDocument('<div id="target" style="--accent:blue!important;--accent:orange;color:var(--accent);margin:2px;margin-left:7px!important;content:\'principal\'">text</div>');
  const sheets = [
    '#target {--accent:red!important;color:purple!important;margin-left:9px!important;background-color:var(--accent)}',
    '#target::before {--accent:gold;content:"before";color:var(--accent);margin-left:inherit}',
  ];
  try {
    const target = document.getElementById('target');
    const engine = new StyleEngine().compute(document, sheets);
    const original = engine.get(target), originalCustom = engine.customPropertiesOf(target);
    expect(original).toMatchObject({
      color:'rgba(128, 0, 128, 1)', backgroundColor:'rgba(0, 0, 255, 1)', margin:[2,2,2,7], content:'principal',
    });
    expect(originalCustom.get('--accent')).toBe('blue');
    expect(engine.getPseudo(target, 'before')).toMatchObject({ content:'before', color:'rgba(255, 215, 0, 1)', margin:[0,0,0,7] });

    target.setAttribute('style', '--accent:lime!important;color:var(--accent)!important;margin:4px;margin-left:8px!important');
    engine.compute(document, sheets, {}, new Set([target]));
    expect(engine.get(target)).toMatchObject({
      color:'rgba(0, 255, 0, 1)', backgroundColor:'rgba(0, 255, 0, 1)', margin:[4,4,4,8], content:null,
    });
    expect(engine.customPropertiesOf(target).get('--accent')).toBe('lime');
    expect(engine.getPseudo(target, 'before')).toMatchObject({ content:'before', color:'rgba(255, 215, 0, 1)', margin:[0,0,0,8] });
    expect(original.backgroundColor).toBe('rgba(0, 0, 255, 1)');
    expect(originalCustom.get('--accent')).toBe('blue');
  } finally { window.happyDOM.abort(); }
});

test('inline shorthands retain their priority over UA defaults and dimension hints', () => {
  const { document, window } = parseHTMLDocument('<h1 id="heading" style="font:italic 20px serif;margin:3px">heading</h1><img id="picture" width="17" height="19" style="width:33px;height:44px">');
  try {
    const engine = new StyleEngine().compute(document, ['#picture {width:80px!important}']);
    expect(engine.get(document.getElementById('heading'))).toMatchObject({
      fontSize:20, fontWeight:400, fontStyle:'italic', fontFamily:['serif'], margin:[3,3,3,3],
    });
    expect(engine.get(document.getElementById('picture'))).toMatchObject({ width:80, height:44 });
  } finally { window.happyDOM.abort(); }
});

test('direct computed-style calls still cascade inline values without mutating supplied declarations', () => {
  const { document, window } = parseHTMLDocument('<div style="color:blue;width:31px;padding:2px">text</div>');
  try {
    const element = document.querySelector('div');
    const declarations = parseDeclarations('color:purple!important;width:10px');
    const originalWidth = declarations.get('width');
    const first = computeElementStyle(element, null, declarations);
    expect(first).toMatchObject({ color:'rgba(128, 0, 128, 1)', width:31, padding:[2,2,2,2] });
    expect(declarations.size).toBe(2);
    expect(declarations.get('width')).toBe(originalWidth);
    expect(originalWidth.value).toBe('10px');

    declarations.set('color', { ...declarations.get('color'), value:'green' });
    element.setAttribute('style', 'color:blue;width:41px;padding:4px');
    const second = computeElementStyle(element, null, declarations);
    expect(second).toMatchObject({ color:'rgba(0, 128, 0, 1)', width:41, padding:[4,4,4,4] });
    expect(first.width).toBe(31);
    expect(first.color).toBe('rgba(128, 0, 128, 1)');
  } finally { window.happyDOM.abort(); }
});

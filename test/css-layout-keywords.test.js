import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {normalizeLayoutKeyword} from '../lib/style/css-layout-keywords.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';

test('implemented layout keywords share CSSOM, declaration and supports validation', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const [name, valid] of [['box-sizing', 'border-box'], ['position', 'relative'], ['flex-direction', 'column']]) {
      for (const value of ['auto', 'garbage', '1', 'normal()', '"relative"', `${valid} garbage`, `${valid}, ${valid}`, 'var(foo)', 'var(--)', 'var(--x;)']) {
        style.setProperty(name, valid);
        style.setProperty(name, value);
        expect(style.getPropertyValue(name)).toBe(valid);
        expect(supportsDeclaration(name, value)).toBeFalse();
        expect(parseDeclarations(`${name}:${valid};${name}:${value}`).get(name)?.value).toBe(valid);
      }
      for (const value of [valid, 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'var(--layout)']) {
        expect(supportsDeclaration(name, value)).toBeTrue();
      }
      style.removeProperty(name);
      expect(style.getPropertyValue(name)).toBe('');
    }
    expect(normalizeLayoutKeyword('position', String.raw`\72 elative/**/`)).toBe('relative');
    expect(normalizeLayoutKeyword('box-sizing', 'BORDER-BOX')).toBe('border-box');
    expect(normalizeLayoutKeyword('flex-direction', 'col/**/umn')).toBeNull();
    expect(normalizeLayoutKeyword('position', '\u00a0relative')).toBeNull();
    expect(normalizeLayoutKeyword('display', 'block')).toBeUndefined();
  } finally {window.happyDOM.close();}
});

test('invalid pending layout keywords compute to initial instead of earlier declarations', () => {
  const {window, document} = parseHTMLDocument('<div id="parent"><div id="valid"></div><div id="bad"></div><div id="inherited"></div></div>');
  try {
    const styles = new StyleEngine().compute(document, [`
      #parent { box-sizing:border-box;position:relative;flex-direction:column }
      #valid { box-sizing:var(--box);--box:border-box;position:var(--position);--position:absolute;flex-direction:var(--flex);--flex:row-reverse }
      #bad { box-sizing:border-box;box-sizing:var(--invalid);position:absolute;position:var(--invalid);flex-direction:column;flex-direction:var(--invalid);--invalid:garbage }
      #inherited { box-sizing:inherit;position:inherit;flex-direction:inherit }
    `]);
    const values = id => {
      const style = styles.get(document.getElementById(id));
      return [style.boxSizing, style.position, style.flexDirection];
    };
    expect(values('valid')).toEqual(['border-box', 'absolute', 'row-reverse']);
    expect(values('bad')).toEqual(['content-box', 'static', 'row']);
    expect(values('inherited')).toEqual(['border-box', 'relative', 'column']);
  } finally {window.happyDOM.close();}
});

test('invalid declarations preserve sizing, positioning and flex layout already supported by rendering', () => {
  const {window, document} = parseHTMLDocument('<body style="margin:0"><div id="root"><div id="first"></div><div id="second"></div><div id="absolute"></div></div></body>');
  try {
    const styles = new StyleEngine().compute(document, [`
      #root { display:flex;flex-direction:column;flex-direction:auto;width:200px;height:100px;position:relative;position:auto }
      #first { box-sizing:border-box;box-sizing:padding-box;width:100px;height:30px;padding:5px;border:2px solid black;flex-shrink:0 }
      #second { width:20px;height:20px;flex-shrink:0 }
      #absolute { position:absolute;position:auto;left:120px;top:10px;width:10px;height:10px }
    `]);
    const tree = new RenderTreeBuilder().build(document, styles);
    const layout = layoutText(tree, {x:0,y:0,width:400,viewportHeight:300,lineHeight:20,measureText:text=>text.length*10,fontMetrics:()=>({ascent:16,height:20})});
    const rect = id => {
      const element = document.getElementById(id);
      const box = layout.boxes.find(candidate => tree.nodesById.get(candidate.nodeId)?.domNode === element);
      return [box.x,box.y,box.width,box.height];
    };
    expect(rect('first')).toEqual([0,0,100,30]);
    expect(rect('second')).toEqual([0,30,20,20]);
    expect(rect('absolute')).toEqual([120,10,10,10]);
  } finally {window.happyDOM.close();}
});

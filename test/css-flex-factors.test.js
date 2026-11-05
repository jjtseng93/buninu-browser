import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {normalizeFlexFactor, computedFlexFactor} from '../lib/style/flex-factor-values.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';

test('flex factors parse CSS number tokens without losing exponent notation or tiny values', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const name of ['flex-grow', 'flex-shrink']) {
      for (const [input, expected] of [['23.4e5','2340000'],['+.678E9','678000000'],['.0','0'],['-0','0'],['1e-7','1e-7'],['2/**/','2']]) {
        style.setProperty(name, input);
        expect(style.getPropertyValue(name)).toBe(expected);
        expect(supportsDeclaration(name, input)).toBeTrue();
        expect(parseDeclarations(`${name}:${input}`).get(name).value).toBe(expected);
      }
      for (const value of ['1.','2e3.4','-+5','6 7','-1','-1e-7','0xff','1px','1%','infinite','NaN','"1"','1/**/e3','var(foo)','var(--)']) {
        style.setProperty(name, '2');style.setProperty(name, value);
        expect(style.getPropertyValue(name)).toBe('2');
        expect(supportsDeclaration(name, value)).toBeFalse();
        expect(parseDeclarations(`${name}:2;${name}:${value}`).get(name).value).toBe('2');
      }
      for (const value of ['inherit','initial','unset','revert','revert-layer','var(--factor)']) expect(supportsDeclaration(name, value)).toBeTrue();
      style.removeProperty(name);expect(style.getPropertyValue(name)).toBe('');
    }
    style.flex='1e2 3e2 0px';
    expect([style.flexGrow,style.flexShrink,style.flexBasis]).toEqual(['100','300','0px']);
    style.flex='calc(1 + 2) 2 0px';
    expect([style.flexGrow,style.flexShrink,style.flexBasis]).toEqual(['calc(3)','2','0px']);
  } finally {window.happyDOM.close();}
});

test('flex factor math resolves before layout and invalid substitutions use their initial values', () => {
  const {window, document} = parseHTMLDocument('<div id="parent"><div id="valid"></div><div id="invalid"></div><div id="inherited"></div></div>');
  try {
    for (const [input, normalized, computed] of [['calc(1 / 2)','calc(0.5)',.5],['calc(-1)','calc(-1)',0],['calc(4px / 2px)','calc(2)',2],['max(1, 3)','calc(3)',3]]) {
      expect(normalizeFlexFactor('flex-grow',input)).toBe(normalized);
      expect(computedFlexFactor(normalized)).toBe(computed);
    }
    expect(normalizeFlexFactor('flex-grow','calc(1px + 2px)')).toBeNull();
    expect(normalizeFlexFactor('flex-grow','calc(1+2)')).toBeNull();
    const styles = new StyleEngine().compute(document, [`
      #parent{flex-grow:2;flex-shrink:3}
      #valid{flex-grow:var(--grow);--grow:calc(1 / 2);flex-shrink:1e-7}
      #invalid{flex-grow:4;flex-grow:var(--x);flex-shrink:4;flex-shrink:var(--x);--x:garbage}
      #inherited{flex-grow:inherit;flex-shrink:inherit}
    `]);
    const values = id => { const s=styles.get(document.getElementById(id));return [s.flexGrow,s.flexShrink]; };
    expect(values('valid')).toEqual([.5,1e-7]);
    expect(values('invalid')).toEqual([0,1]);
    expect(values('inherited')).toEqual([2,3]);
  } finally {window.happyDOM.close();}
});

test('CSSOM exponent factors affect real flex growth and shrink distribution', () => {
  const {window, document} = parseHTMLDocument('<body style="margin:0"><div id="root"><div id="a"></div><div id="b"></div></div></body>');
  try {
    const a=document.getElementById('a'),b=document.getElementById('b');
    const widths = () => {
      const styles = new StyleEngine().compute(document, ['#root{display:flex;width:100px;height:10px}#root>div{height:10px;min-width:0}']);
      const tree = new RenderTreeBuilder().build(document,styles);
      const layout=layoutText(tree,{x:0,y:0,width:400,lineHeight:10,measureText:text=>text.length*10,fontMetrics:()=>({ascent:8,height:10})});
      return [a,b].map(element=>layout.boxes.find(box=>tree.nodesById.get(box.nodeId)?.domNode===element).width);
    };
    a.style.cssText='flex-grow:1e2;flex-basis:0px';b.style.cssText='flex-grow:3e2;flex-basis:0px';
    expect(widths()).toEqual([25,75]);
    a.style.cssText='flex-shrink:1e2;flex-basis:100px';b.style.cssText='flex-shrink:3e2;flex-basis:100px';
    expect(widths()).toEqual([75,25]);
    a.style.flexShrink='1.';
    expect(widths()).toEqual([75,25]);
    a.style.flex='calc(1 + 2) 1 0px';b.style.flex='1 1 0px';
    expect(widths()).toEqual([75,25]);
  } finally {window.happyDOM.close();}
});

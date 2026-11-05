import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeBorderValue} from '../lib/style/border-values.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';
import {RendererHost} from '../lib/renderer/host.js';

test('border component counts and duplicates share validation across CSSOM, sheets and feature queries',()=>{
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const style=document.querySelector('div').style;
    for(const [name,valid,invalid] of [
      ['border-width','1px 2px 3px 4px',['thin medium thick medium thin','-1px','10%','2','calc(1px + 2)','"1px"']],
      ['border-style','solid dotted double dashed',['solid dotted double dashed ridge','solid,none','"solid"','auto']],
      ['border-color','red #123 rgb(4, 5, 6) currentcolor',['red blue green black white','red,blue','# f00','none']],
      ['border','2px solid #f00',['thin double green 1px','solid dashed','red blue','-2em','1px solid red 2px']],
    ]) {
      style.setProperty(name,valid);expect(style.getPropertyValue(name)).not.toBe('');
      expect(supportsDeclaration(name,valid)).toBeTrue();
      for(const value of invalid) {
        style.setProperty(name,valid,'important');const before=style.getPropertyValue(name);style.setProperty(name,value);
        expect(style.getPropertyValue(name)).toBe(before);expect(style.getPropertyPriority(name)).toBe('important');
        expect(parseDeclarations(`${name}:${valid};${name}:${value}`)).toEqual(parseDeclarations(`${name}:${valid}`));
        expect(supportsDeclaration(name,value)).toBeFalse();
      }
      style.removeProperty(name);expect(style.getPropertyValue(name)).toBe('');
    }
    for(const side of ['top','right','bottom','left'])for(const [kind,value] of [['width','calc(-2px)'],['style','s\\6f lid'],['color','CURRENTCOLOR']]) {
      const name=`border-${side}-${kind}`;
      style.setProperty(name,value);expect(style.getPropertyValue(name)).toBe(normalizeBorderValue(name,value));
      for(const pending of ['VAR(--日本)','var(--missing, 2px)']) {
        style.setProperty(name,pending);expect(style.getPropertyValue(name)).toBe(pending);
      }
    }
    style.cssText='border:2px solid #f00;border:thin double green 1px';
    expect(style.borderTopWidth).toBe('2px');expect(style.borderTopStyle).toBe('solid');
    expect(normalizeBorderValue('border','2px/**/solid/**/#f00')).toBe('2px solid #f00');
    expect(normalizeBorderValue('border-color','#f\\30 0')).toBe('#f00');
    expect(normalizeBorderValue('border-image','none')).toBeUndefined();
  } finally {window.happyDOM.close();}
});

test('border math clamps after computation and inherited or invalid pending values reset correctly',()=>{
  const {window,document}=parseHTMLDocument('<main id=p><div id=a></div><div id=b></div><div id=c></div></main>');
  try {
    const p=document.getElementById('p'),a=document.getElementById('a'),b=document.getElementById('b'),c=document.getElementById('c');
    p.style.cssText='font-size:20px;color:blue;border:4px solid currentcolor';
    a.style.cssText='border-style:solid;border-width:calc(2px - .5em) calc(2px + .5em);border-color:currentcolor red';
    b.style.cssText='border:8px dashed red;border-width:var(--bad);border-style:var(--bad);border-color:var(--bad);--bad:nonsense';
    c.style.cssText='color:red;border:inherit';
    const styles=new StyleEngine().compute(document);
    expect(styles.get(a).borderWidths).toEqual([0,12,0,12]);
    expect(styles.get(a).borderColors).toEqual(['rgba(0, 0, 255, 1)','rgba(255, 0, 0, 1)','rgba(0, 0, 255, 1)','rgba(255, 0, 0, 1)']);
    expect(styles.get(b).borderWidths).toEqual([0,0,0,0]);expect(styles.get(b).borderStyles).toEqual(['none','none','none','none']);
    expect(styles.get(b).borderColors).toEqual(Array(4).fill('rgba(0, 0, 255, 1)'));
    expect(styles.get(c).borderWidths).toEqual([4,4,4,4]);expect(styles.get(c).borderColors).toEqual(Array(4).fill('rgba(0, 0, 255, 1)'));
    a.style.cssText='--日本:calc(6px / 2px * 3px);border:solid green;border-width:VAR(--日本)';
    expect(new StyleEngine().compute(document).get(a).borderWidths).toEqual([9,9,9,9]);
    a.style.cssText='border:5px solid red;all:initial';expect(new StyleEngine().compute(document).get(a).borderWidths).toEqual([0,0,0,0]);
  } finally {window.happyDOM.close();}
});

test('validated borders retain actual box geometry and painter border commands',()=>{
  const {window,document}=parseHTMLDocument('<body style="margin:0"><div id=box style="width:40px;height:20px;font-size:20px;color:blue;border:2px solid currentcolor;border-left-width:calc(1px + .5em);border-bottom-width:calc(-1px)"></div></body>');
  try {
    const box=document.getElementById('box');
    const paint=()=>{
      const tree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document));
      const layout=layoutText(tree,{x:0,y:0,width:200}),list=buildDisplayList(layout,tree);
      return list.items.find(item=>item.op==='border'&&tree.nodesById.get(item.nodeId)?.domNode===box);
    };
    expect(paint()).toMatchObject({rect:{x:0,y:0,width:53,height:22},widths:[2,2,0,11],styles:Array(4).fill('solid'),colors:Array(4).fill('rgba(0, 0, 255, 1)')});
    box.style.border='thin solid red 4px';expect(paint().widths).toEqual([2,2,0,11]);
    box.style.borderStyle='hidden none solid solid';expect(paint().widths).toEqual([0,0,0,11]);
  } finally {window.happyDOM.close();}
});

test('pending border declarations retain their original source and compute before side overrides',()=>{
  const {window,document}=parseHTMLDocument('<div id=box></div>');
  try {
    const box=document.getElementById('box');
    for(const variable of ['var(--x)','VAR(--日本)']) {
      box.style.cssText=`--x:2px solid red;--日本:2px solid red;border:${variable}`;
      expect(box.style.border).toBe(variable);
      expect(new StyleEngine().compute(document).get(box).borderWidths).toEqual([2,2,2,2]);
      box.style.setProperty('border',variable,'important');
      expect(box.style.getPropertyPriority('border')).toBe('important');
      box.style.removeProperty('border');expect(box.style.border).toBe('');
      expect(new StyleEngine().compute(document).get(box).borderWidths).toEqual([0,0,0,0]);
      box.removeAttribute('style');
      // Raw stylesheet declarations preserve the order of a pending shorthand
      // and later side declarations, independently of CSSOM serialization.
      for(const [declarations,widths] of [
        [`border:${variable};border-left-width:5px`,[2,2,2,5]],
        [`border-left-width:5px!important;border:${variable}`,[2,2,2,5]],
        [`border:8px solid blue;border:${variable};all:initial`,[0,0,0,0]],
      ]) {
        const styles=new StyleEngine().compute(document,[`#box {--x:2px solid red;--日本:2px solid red;${declarations}}`]);
        expect(styles.get(box).borderWidths).toEqual(widths);
      }
    }
    box.style.cssText='--edge:2px solid blue;--scroll:auto hidden;border:var(--edge);overflow:var(--scroll);overflow-x:scroll';
    const before=new StyleEngine().compute(document).get(box);
    expect(before.borderWidths).toEqual([2,2,2,2]);
    expect([before.overflowValueX,before.overflowValueY]).toEqual(['scroll','hidden']);
    box.style.all='initial';
    const after=new StyleEngine().compute(document).get(box);
    expect(after.borderWidths).toEqual([0,0,0,0]);
    expect([after.overflowValueX,after.overflowValueY]).toEqual(['visible','visible']);
  } finally {window.happyDOM.close();}
});

test('live border computed shorthands serialize their four physical sides canonically',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div id=box style="color:blue;border-style:solid;border-width:1px 2px 3px;border-color:currentcolor red"></div>'});await host.call('whenLoaded');
    expect(await host.call('evaluate',`(()=>{const box=document.getElementById('box'),s=getComputedStyle(box),first=[s.borderWidth,s.borderStyle,s.borderColor];box.style.borderWidth='calc(-2px) 4px';return [first,[s.borderWidth,s.getPropertyValue('border-width')],CSS.supports('border','thin solid red 4px')];})()`)).toEqual([['1px 2px 3px','solid','rgb(0, 0, 255) rgb(255, 0, 0)'],['0px 4px','0px 4px'],false]);
  } finally {await host.close();}
});

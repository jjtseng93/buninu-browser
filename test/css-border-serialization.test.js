import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {normalizeBorderValue} from '../lib/style/border-values.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RendererHost} from '../lib/renderer/host.js';

test('specified border hex colors serialize as legacy sRGB without changing color bytes',()=>{
  const {window,document}=parseHTMLDocument('<div></div>'),box=document.querySelector('div'),s=box.style;
  try {
    for(const [hex,color] of [['#fff','rgb(255, 255, 255)'],['#abc','rgb(170, 187, 204)'],['#1234','rgba(17, 34, 51, 0.267)'],['#0f08','rgba(0, 255, 0, 0.533)'],['#ABCDEF','rgb(171, 205, 239)'],['#abcdef78','rgba(171, 205, 239, 0.47)'],['#00000000','rgba(0, 0, 0, 0)'],['#000000ff','rgb(0, 0, 0)']]) {
      for(const side of ['','-top','-right','-bottom','-left']) {
        s.cssText=`border${side}:2px solid ${hex}`;
        expect(s.getPropertyValue(`border${side}`)).toBe(`2px solid ${color}`);
        expect(s.cssText).toBe(`border${side}: 2px solid ${color};`);
        const before=new StyleEngine().compute(document).get(box).borderColors;
        s.cssText=s.cssText;
        expect(new StyleEngine().compute(document).get(box).borderColors).toEqual(before);
      }
    }
    for(let alpha=0;alpha<256;alpha++) {
      const hex='#123456'+alpha.toString(16).padStart(2,'0');
      const serialized=normalizeBorderValue('border-color',hex);
      expect(Bun.color(serialized,'hex')).toBe(Bun.color(hex,'hex'));
      expect(Bun.color(serialized,'rgba')).toBe(Bun.color(hex,'rgba'));
    }
    for(const named of ['red','transparent','currentcolor'])expect(normalizeBorderValue('border-color',named)).toBe(named);
    for(const invalid of ['#f','#ff','#fffff','#fffffff','#000000000','#xyz']) {
      s.cssText='border:2px solid red';s.borderColor=invalid;
      expect(s.borderColor).toBe('red');expect(normalizeBorderValue('border-color',invalid)).toBeNull();
    }
    s.cssText='--edge:2px solid #1234;border:var(--edge)';
    expect(s.border).toBe('var(--edge)');
    expect(new StyleEngine().compute(document).get(box).borderColors).toEqual(Array(4).fill(Bun.color('#1234','rgba')));
  } finally {window.happyDOM.close();}
});

test('computed side and full border shorthands are live and reflect actual resolved borders',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.call('loadDocument',{url:'https://border-serialization.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#box{width:40px;height:20px;color:blue}</style><div id=box></div>'});
    await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code),shot=()=>host.call('screenshot',{format:'png'});
    await run(`window.box=document.getElementById('box');window.s=getComputedStyle(box);`);
    expect(await run(`s.border`)).toBe('0px none rgb(0, 0, 255)');
    await run(`box.style.border='3px solid #1234'`);
    expect(await run(`[s.border,s.borderTop,s.borderRight,s.borderBottom,s.borderLeft,s.getPropertyValue('border')]`))
      .toEqual(Array(6).fill('3px solid rgba(17, 34, 51, 0.267)'));
    const hex=await shot();
    await run(`box.style.border='3px solid rgba(17, 34, 51, 0.267)'`);
    expect(await shot()).toBe(hex);
    for(const [property,value] of [['borderLeftWidth','4px'],['borderRightStyle','dashed'],['borderBottomColor','red']]) {
      await run(`box.style.border='3px solid currentcolor';box.style.${property}=${JSON.stringify(value)}`);
      expect(await run(`s.border`)).toBe('');
      expect(await run(`s.borderTop`)).toBe('3px solid rgb(0, 0, 255)');
    }
    await run(`box.style.border='3px none red'`);
    expect(await run(`[s.border,s.borderTop]`)).toEqual(['0px none rgb(255, 0, 0)','0px none rgb(255, 0, 0)']);
    await run(`box.style.cssText='border:3px solid red;border-image-source:url(about:blank)'`);
    expect(await run(`[box.style.border,s.border]`)).toEqual(['','3px solid rgb(255, 0, 0)']);
    await run(`box.style.cssText='border:3px solid currentcolor';box.style.color='green'`);
    expect(await run(`s.border`)).toBe('3px solid rgb(0, 128, 0)');
  } finally {await host.close();}
},30000);

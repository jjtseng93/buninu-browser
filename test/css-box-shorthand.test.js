import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {parseCSSOMRules,renderStyleSheet} from '../lib/renderer/stylesheet-parser.js';
import {RendererHost} from '../lib/renderer/host.js';

test('box shorthands preserve every mixture of longhand priorities through cssText',()=>{
  const {window,document}=parseHTMLDocument('<div id=box></div>'),box=document.querySelector('div'),s=box.style;
  try {
    for(const name of ['margin','padding'])for(const value of ['10px','initial','inherit'])for(let mask=0;mask<16;mask++) {
      s.cssText='';
      const fields=['right','left','top','bottom'].map(side=>`${name}-${side}`);
      fields.forEach((field,i)=>s.setProperty(field,value,mask&(1<<i)?'important':''));
      const uniform=mask===0||mask===15;
      expect(s.getPropertyValue(name)).toBe(uniform?value:'');
      expect(s.getPropertyPriority(name)).toBe(mask===15?'important':'');
      const serialized=s.cssText,original=fields.map(field=>[s.getPropertyValue(field),s.getPropertyPriority(field)]);
      if(uniform)expect(serialized).toBe(`${name}: ${value}${mask===15?' !important':''};`);
      else expect(serialized).toBe(fields.map((field,i)=>`${field}: ${value}${mask&(1<<i)?' !important':''};`).join(' '));
      s.cssText=serialized;
      expect(fields.map(field=>[s.getPropertyValue(field),s.getPropertyPriority(field)])).toEqual(original);
    }
    for(const name of ['margin','padding'])for(const value of ['1px','1px 2px','1px 2px 3px','1px 2px 3px 4px']) {
      s.cssText=`${name}:${value}!important`;
      expect(s.getPropertyValue(name)).toBe(value);
      expect(s.cssText).toBe(`${name}: ${value} !important;`);
      s.removeProperty(`${name}-left`);expect(s.getPropertyValue(name)).toBe('');
    }
  } finally {window.happyDOM.close();}
});

test('CSSOM box serialization retains priority against competing stylesheet declarations',()=>{
  const {window,document}=parseHTMLDocument('<div id=box></div>'),box=document.querySelector('div');
  try {
    for(const name of ['margin','padding']) {
      const rules=parseCSSOMRules(window,`#box{${name}:10px}`,null),rule=rules[0];
      rule.style.setProperty(`${name}-bottom`,'20px','important');
      const styles=[renderStyleSheet(rules),`#box{${name}:30px}`];
      expect(new StyleEngine().compute(document,styles).get(box)[name]).toEqual([30,30,20,30]);
      box.style.cssText=`${name}:10px`;box.style.setProperty(`${name}-bottom`,'20px','important');
      expect(new StyleEngine().compute(document,[`#box{${name}:30px!important}`]).get(box)[name]).toEqual([30,30,20,30]);
      box.style.cssText='';
    }
  } finally {window.happyDOM.close();}
});

test('mixed box priorities remain visible after inline and rule mutation',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.call('loadDocument',{url:'https://box-priority.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#box{width:20px;height:20px;background:red;margin:30px!important;padding:30px!important}</style><div id=box></div>'});
    await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code),shot=()=>host.call('screenshot',{format:'png'});
    await run(`window.box=document.getElementById('box');box.style.cssText='margin:10px;padding:10px';box.style.setProperty('margin-bottom','20px','important');box.style.setProperty('padding-bottom','20px','important')`);
    expect(await run(`(()=>{const s=getComputedStyle(box);return [s.marginTop,s.marginBottom,s.paddingTop,s.paddingBottom]})()`)).toEqual(['30px','20px','30px','20px']);
    const mixed=await shot();await run(`box.style.cssText=box.style.cssText`);expect(await shot()).toBe(mixed);
    await run(`box.style.setProperty('padding-bottom','40px','important')`);expect(await shot()).not.toBe(mixed);
  } finally {await host.close();}
},30000);

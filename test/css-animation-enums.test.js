import {test, expect} from 'bun:test';
import {normalizeAnimationEnum, animationEnumValue} from '../lib/style/animation-enum-values.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {RendererHost} from '../lib/renderer/host.js';

const names=['animation-direction','animation-fill-mode','animation-play-state'];
test('animation enum parsing accepts CSS identifiers and lists, rejects invalid grammar',()=>{
 for(const [name,source,expected] of [
  [names[0], ' NORMAL/**/, REVERSE ,alternate-reverse ', 'normal, reverse, alternate-reverse'],
  [names[0], String.raw`\72 everse, \00006e ormal`, 'reverse, normal'],
  [names[1], 'none, backwards, BOTH', 'none, backwards, both'],
  [names[2], 'RUNNING,paused', 'running, paused'],
  [names[0], 'INHERIT', 'inherit'],
 ]) expect(normalizeAnimationEnum(name,source)).toBe(expected);
 for(const name of names) {
  for(const value of ['','auto',',','normal,','initial, reverse','reverse, initial','"var(--x)"','var(foo)','var(--)','env()','env(1foo)','var(--x;)', 'env(name -1)', 'nor/**/mal', 'none running', '\\', 'reverse)', '\u00a0reverse', '{}var(--x)', 'var(--x){}'])
   expect(normalizeAnimationEnum(name,value)).toBeNull();
  for(const value of ['var(--choice)','garbage var(--choice, garbage)', 'var(--a, var(--b,))', 'env(choice)', 'env(viewport 0 1, reverse)', 'env(viewport +0 +1, reverse)'])
   expect(normalizeAnimationEnum(name,value)).toBe(value);
 }
 expect(normalizeAnimationEnum('color','red')).toBeUndefined();
 expect(normalizeAnimationEnum(names[0],'var(--x,'+'('.repeat(140)+'x'+')'.repeat(140)+')')).toBeNull();
});

test('CSSOM and declaration cascade preserve valid values before invalid overrides',()=>{
 const {window,document}=parseHTMLDocument('<div></div>');
 try {
  const style=document.querySelector('div').style;
  for(const [name,value] of [[names[0],'reverse'],[names[1],'both'],[names[2],'paused']]) {
   style.setProperty(name,value);style.setProperty(name,'garbage');expect(style.getPropertyValue(name)).toBe(value);
   expect(parseDeclarations(`${name}:${value};${name}:garbage`).get(name).value).toBe(value);
   expect(supportsDeclaration(name,value)).toBe(true);expect(supportsDeclaration(name,'garbage')).toBe(false);
   expect(supportsDeclaration(name,'var(--x)')).toBe(true);expect(supportsDeclaration(name,'var(foo)')).toBe(false);
  }
  style.animationDirection=String.raw`\72 everse`;
  expect(style.animationDirection).toBe('reverse');
 } finally {window.happyDOM.close();}
});

test('style engine applies normalized animation enums and CSS-wide resets',()=>{
 const {window,document}=parseHTMLDocument(`<div id="parent" style="animation:move 1s reverse both paused"><div id="child" style="animation-direction:inherit;animation-fill-mode:inherit;animation-play-state:inherit"></div></div><div id="reset" style="animation:move 1s reverse both paused;animation-direction:INITIAL;animation-fill-mode:unset;animation-play-state:var(--bad);--bad:invalid"></div><div id="valid" style="animation-direction:reverse;animation-direction:invalid;animation-fill-mode:var(--mode);--mode:both"></div>`);
 try {
  const engine=new StyleEngine().compute(document);
  const values=id=>names.map(name=>animationEnumValue(engine.get(document.getElementById(id)),name));
  expect(values('child')).toEqual(['reverse','both','paused']);
  expect(values('reset')).toEqual(['normal','none','running']);
  expect(values('valid')).toEqual(['reverse','both','running']);
 } finally {window.happyDOM.close();}
});

test('page CSS.supports and CSSOM reject invalid animation mutations without notifying observers',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div style="animation-direction:reverse"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const e=document.querySelector('div'),o=new MutationObserver(()=>{});o.observe(e,{attributes:true});
   e.style.animationDirection='invalid';const records=o.takeRecords().length;o.disconnect();
   return [e.style.animationDirection,records,CSS.supports('animation-direction','reverse'),CSS.supports('animation-direction','reverse, initial'),CSS.supports('animation-fill-mode','both'),CSS.supports('animation-play-state','paused')];
  })()`)).toEqual(['reverse',0,true,false,true,true]);
 } finally {await host.close();}
});

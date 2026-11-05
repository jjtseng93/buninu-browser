import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('live CSSOM rules mutate rendering without rewriting style text nodes',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style id="css">#box {color:red} @media all {#box {width:42px}}</style><div id="box">test</div>'});await host.call('whenLoaded');
  const result=await host.call('evaluate',`(()=>{
   const el=document.getElementById('css'),box=document.getElementById('box'),s=el.sheet,list=s.cssRules,sheets=document.styleSheets,original=el.textContent;
   const r=[s===el.sheet,s===sheets[0],s.ownerNode===el,s instanceof CSSStyleSheet,list.length,list[0] instanceof CSSStyleRule,list[0].style.parentRule===list[0],list[1].cssRules[0].parentRule===list[1],getComputedStyle(box).color];
   list[0].style.color='blue';r.push(getComputedStyle(box).color,el.textContent===original);
   s.insertRule('#box {height:31px}');r.push(list.length,list[0].style.height,getComputedStyle(box).height);
   s.deleteRule(0);r.push(list.length,getComputedStyle(box).height);
   list[1].cssRules[0].style.width='55px';r.push(getComputedStyle(box).width);
   s.disabled=true;r.push(getComputedStyle(box).color,el.disabled);el.disabled=false;r.push(getComputedStyle(box).color);
   el.textContent='#box {color:green}';r.push(el.sheet!==s,getComputedStyle(box).color);
   el.remove();r.push(sheets.length,el.sheet===null);return r;
  })()`);
  expect(result).toEqual([true,true,true,true,2,true,true,true,'rgb(255, 0, 0)','rgb(0, 0, 255)',true,3,'31px','31px',2,'19px','55px','rgb(0, 0, 0)',true,'rgb(0, 0, 255)',true,'rgb(0, 128, 0)',0,true]);
 }finally{await host.close();}
});

test('loaded sheets mutate the cascade, while cross-origin rules stay protected',async()=>{
 const host=new RendererHost({timeout:20000,fetch:async url=>new Response(new URL(url).pathname==='/local.css'?'#box {color:red}':'#box {width:66px}',{headers:{'content-type':'text/css'}})});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><link id="local" rel="stylesheet" href="/local.css"><link id="remote" rel="stylesheet" href="https://other.local/remote.css"><div id="box">text</div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const local=document.getElementById('local').sheet,remote=document.getElementById('remote').sheet,box=document.getElementById('box');const r=[document.styleSheets.length,local.href,remote.href,getComputedStyle(box).width];try{remote.cssRules}catch(e){r.push(e.name)}try{remote.insertRule('body{}')}catch(e){r.push(e.name)}local.cssRules[0].style.color='blue';r.push(getComputedStyle(box).color);return r})()`)).toEqual([2,'https://test.local/local.css','https://other.local/remote.css','66px','SecurityError','SecurityError','rgb(0, 0, 255)']);
 }finally{await host.close();}
});

test('rule validation is atomic and constructed sheets parse individual rules',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style>div{color:red}</style>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const s=new CSSStyleSheet(),r=[];s.replaceSync('a{color:red}b{color:blue}');const rules=s.cssRules;r.push(rules.length);for(const action of [()=>s.insertRule('a{}b{}'),()=>s.deleteRule(2),()=>s.insertRule('a{}',4),()=>document.styleSheets[0].replaceSync('a{}')])try{action()}catch(e){r.push(e.name)}r.push(rules.length,s.cssRules===rules);s.deleteRule(0);r.push(rules.length,rules[0].selectorText);return r})()`)).toEqual([2,'SyntaxError','IndexSizeError','IndexSizeError','NotAllowedError',2,true,1,'b']);
 }finally{await host.close();}
});

test('editing another rule preserves cascade layers and quoted CSS delimiters',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:`<!doctype html><style>@layer a,b; @layer a {#box {color:red}} @layer b {#box {color:blue}} #box {height:20px;--quoted:"a{};b"}</style><div id="box">text</div>`});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const sheet=document.styleSheets[0],box=document.getElementById('box'),r=[sheet.cssRules.length,getComputedStyle(box).color];sheet.cssRules[3].style.height='33px';r.push(getComputedStyle(box).color,getComputedStyle(box).height,sheet.cssRules[3].style.getPropertyValue('--quoted'));sheet.cssRules[2].cssRules[0].style.color='green';r.push(getComputedStyle(box).color);return r})()`)).toEqual([4,'rgb(0, 0, 255)','rgb(0, 0, 255)','33px','"a{};b"','rgb(0, 128, 0)']);
 }finally{await host.close();}
});

test('CSSOM edits repaint pixels and deletion restores the prior image',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style>body{background:red}</style>'});await host.call('whenLoaded');
  const before=await host.call('screenshot');
  await host.call('evaluate',"document.styleSheets[0].insertRule('body{background:blue}',1)");
  const after=await host.call('screenshot');expect(after).not.toBe(before);
  await host.call('evaluate','document.styleSheets[0].deleteRule(1)');
  expect(await host.call('screenshot')).toBe(before);
 }finally{await host.close();}
});

import {test,expect} from 'bun:test';
import {observableSheets} from '../lib/renderer/adopted-stylesheets.js';
import {RendererHost} from '../lib/renderer/host.js';

test('observable adoption validates mutations, keeps identity and cannot create holes',()=>{
 let current=[];const a={},b={};
 const record=observableSheets(v=>{if(v!==a&&v!==b)throw new TypeError('sheet');},v=>current=[...v]);
 const list=record.view;record.replace([a,b]);expect(record.view).toBe(list);
 list.reverse();expect(current).toEqual([b,a]);list.splice(0,1);expect(current).toEqual([a]);
 expect(()=>list.push('bad')).toThrow();expect(current).toEqual([a]);
 expect(Reflect.set(list,'2',b)).toBe(false);expect(Reflect.set(list,'length',9)).toBe(false);
 record.replace([a,b,a]);list.pop();expect(current).toEqual([a,b]);
 list.length=0;expect(current).toEqual([]);
 record.replace([a]);expect(()=>record.replace([b,'bad'])).toThrow();expect(current).toEqual([a]);
 let receiver;const prototype=Object.create(Array.prototype,{probe:{set(){receiver=this;}}});
 Object.setPrototypeOf(list,prototype);list.probe=1;expect(receiver).toBe(list);
 expect(Reflect.preventExtensions(list)).toBe(false);

});

test('document adopted sheets cascade, repaint and invalidate on every mutation without leaking shadow styles',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style>body{background:red} #box{color:red}</style><div id="box">Text</div>'});await host.call('whenLoaded');
  const before=await host.call('screenshot');
  expect(await host.call('evaluate',`(()=>{
   const a=new CSSStyleSheet(),b=new CSSStyleSheet(),box=document.getElementById('box');
   a.replaceSync('body{background:blue} #box{color:blue}');b.replaceSync('#box{color:green}');
   const list=document.adoptedStyleSheets;document.adoptedStyleSheets=[a];
   const color=()=>getComputedStyle(box).color,r=[list===document.adoptedStyleSheets,Array.isArray(list),document.styleSheets.length,color()];
   list.push(b);r.push(color());list.reverse();r.push(color());list.pop();r.push(color());
   b.cssRules[0].style.color='purple';r.push(color());
   b.disabled=true;r.push(color());b.disabled=false;r.push(color());
   list.push(b);list.pop();b.replaceSync('#box{color:blue}');r.push(color());
   try{list.push(document.styleSheets[0])}catch(e){r.push(e.name)}r.push(list.length);
   const shadow=box.attachShadow({mode:'open'}),c=new CSSStyleSheet();c.replaceSync('body{background:lime}');shadow.adoptedStyleSheets=[c];
   document.adoptedStyleSheets=[a];r.push(getComputedStyle(document.body).backgroundColor);
   return r;
  })()`)).toEqual([true,true,1,'rgb(0, 0, 255)','rgb(0, 128, 0)','rgb(0, 0, 255)','rgb(0, 128, 0)','rgb(128, 0, 128)','rgb(255, 0, 0)','rgb(128, 0, 128)','rgb(0, 0, 255)','NotAllowedError',1,'rgb(0, 0, 255)']);
  expect(await host.call('screenshot')).not.toBe(before);
  await host.call('evaluate',"document.adoptedStyleSheets.length=0;document.getElementById('box').shadowRoot.innerHTML='<slot></slot>'");
  expect(await host.call('evaluate','getComputedStyle(document.body).backgroundColor')).toBe('rgb(255, 0, 0)');
 }finally{await host.close();}
});

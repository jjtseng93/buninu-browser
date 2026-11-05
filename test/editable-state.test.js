import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('editable states reflect attributes, inherit dynamically and stop at shadow roots',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div id="outer"><span id="inner"></span></div>'});
  await host.call('whenLoaded');
  const result=await host.call('evaluate',`JSON.stringify((()=>{
   const a=document.getElementById('outer'),b=document.getElementById('inner');
   const r=[document.designMode,a.contentEditable,b.isContentEditable];
   a.contentEditable='TRUE';r.push(a.getAttribute('contenteditable'),b.isContentEditable);
   b.contentEditable='false';r.push(b.isContentEditable);
   b.contentEditable='inherit';r.push(b.hasAttribute('contenteditable'),b.isContentEditable);
   a.setAttribute('contenteditable','invalid');r.push(a.contentEditable,b.isContentEditable);
   document.designMode='ON';r.push(document.designMode,b.isContentEditable);
   document.designMode='invalid';r.push(document.designMode);
   const shadow=a.attachShadow({mode:'open'}),c=document.createElement('span');shadow.append(c);r.push(c.isContentEditable);
   c.contentEditable='plaintext-only';r.push(c.isContentEditable);
   document.designMode='off';r.push(b.isContentEditable);
   try {a.contentEditable='invalid';r.push('accepted')}catch(e){r.push(e.name)}
   const detached=document.createElement('div');r.push(detached.isContentEditable);
   return r;
  })())`);
  expect(JSON.parse(result)).toEqual(['off','inherit',false,'true',true,false,false,true,'inherit',false,'on',true,'on',false,true,false,'SyntaxError',false]);
 }finally{await host.close();}
});

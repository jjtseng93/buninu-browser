import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('computed style writes reject without mutating inline style or breaking live reads',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div style="color:red;background-color:blue"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const el=document.querySelector('div'),s=getComputedStyle(el),r=[s.parentRule];
   for(const modify of [()=>s.color='blue',()=>s['background-color']='red',()=>s.cssText='',()=>s.setProperty('--x','1'),()=>s.removeProperty('color')]){
    try{modify()}catch(e){r.push(e.name,e.code,e instanceof DOMException)}
   }
   r.push(el.style.color,s.color);s.extra=42;r.push(s.extra);el.style.color='green';r.push(s.color);return r;
  })()`)).toEqual([null,...Array.from({length:5},()=>['NoModificationAllowedError',7,true]).flat(),'red','rgb(255, 0, 0)',42,'rgb(0, 128, 0)']);
 }finally{await host.close();}
});

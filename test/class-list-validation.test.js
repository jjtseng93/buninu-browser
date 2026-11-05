import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('classList validates all tokens before mutation and forwards assignment on HTML and SVG',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div><svg></svg>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const r=[];
   for(const e of [document.querySelector('div'),document.querySelector('svg')]){
    e.classList='a b';r.push(e.getAttribute('class'),e.classList.value,String(e.classList));
    for(const [method,args] of [['add',['c','']],['remove',['a','x y']],['toggle',['']],['replace',['a','x y']]]){
     try{e.classList[method](...args)}catch(error){r.push(error.name,error.code)}r.push(e.getAttribute('class'));
    }
    e.classList.add('c');r.push(e.classList.contains('c'));
   }return r;
  })()`)).toEqual(Array.from({length:2},()=>['a b','a b','a b','SyntaxError',12,'a b','InvalidCharacterError',5,'a b','SyntaxError',12,'a b','InvalidCharacterError',5,'a b',true]).flat());
 }finally{await host.close();}
});

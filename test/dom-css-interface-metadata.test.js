import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('DOM unscopables belong to each mixin interface and CSS namespace tag stays configurable',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const r=[];
   for(const C of [Element,CharacterData,DocumentType,DocumentFragment,Document]){
    const d=Object.getOwnPropertyDescriptor(C.prototype,Symbol.unscopables);
    r.push([Object.keys(d.value),Object.getPrototypeOf(d.value)===null,d.writable,d.enumerable,d.configurable]);
   }
   r.push(Element.prototype[Symbol.unscopables]!==Document.prototype[Symbol.unscopables]);
   r.push(Object.prototype.toString.call(CSS));Object.defineProperty(CSS,Symbol.toStringTag,{value:'Other'});r.push(Object.prototype.toString.call(CSS));delete CSS[Symbol.toStringTag];r.push(Object.prototype.toString.call(CSS),CSS.supports('color','red'));return r;
  })()`)).toEqual([
   [['before','after','replaceWith','remove','prepend','append','replaceChildren'],true,false,false,true],
   [['before','after','replaceWith','remove'],true,false,false,true],
   [['before','after','replaceWith','remove'],true,false,false,true],
   [['prepend','append','replaceChildren'],true,false,false,true],
   [['prepend','append','replaceChildren'],true,false,false,true],
   true,'[object CSS]','[object Other]','[object Object]',true
  ]);
 }finally{await host.close();}
});

import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('CSS declaration indexes stay live and readonly while expandos remain ordinary',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const s=document.querySelector('div').style;s.color='red';s.backgroundColor='blue';s.extra=42;
   const i=s[Symbol.iterator](),r=[Object.keys(s),i.next().value];
   s.setProperty('width','10px');r.push([...i],Object.getOwnPropertyDescriptor(s,'0'),Reflect.set(s,'0','bad'),Reflect.defineProperty(s,'9',{value:'bad'}),Reflect.deleteProperty(s,'0'),Reflect.preventExtensions(s));
   s.removeProperty('color');r.push(s[0],Object.keys(s),s.extra);s.cssText='';r.push([...s],Object.keys(s));return r;
  })()`)).toEqual([['0','1','extra'],'color',['background-color','width'],{value:'color',writable:false,enumerable:true,configurable:true},false,false,false,false,'background-color',['0','1','extra'],42,[],['extra']]);
 }finally{await host.close();}
});

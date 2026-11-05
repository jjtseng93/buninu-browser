import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('classList is live during iteration and preserves no-op mutations',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const e=document.querySelector('div'),l=e.classList,r=[];
   l.remove('absent');r.push(e.hasAttribute('class'));
   e.className='  a a  b ';const observer=new MutationObserver(()=>{});observer.observe(e,{attributes:true});
   r.push(l.toggle('a',true),l.toggle('z',false),e.className,observer.takeRecords().length);
   const i=l.values();r.push(i.next().value);l.add('c');r.push([...i],Object.keys(l));
   const visited=[];l.forEach((value,index,list)=>{visited.push([value,index,list===l]);if(index===0)l.remove('b')});r.push(visited);
   r.push(l[Symbol.iterator]===Array.prototype.values,l.forEach===Array.prototype.forEach);
   r.push(Reflect.set(l,'0','bad'),Reflect.defineProperty(l,'0',{value:'bad'}),Reflect.deleteProperty(l,'0'),Reflect.preventExtensions(l));
   l.value='c b a';r.push(l.replace('c','a'),l.value);
   l.value='a';r.push(l.toggle('a',undefined),l.value);
   try{l.supports('a')}catch(error){r.push(error.constructor===TypeError)}
   observer.disconnect();return r;
  })()`)).toEqual([false,true,false,'  a a  b ',0,'a',['b','c'],['0','1','2'],[['a',0,true],['c',1,true]],true,true,false,false,false,false,true,'a b',false,'',true]);
 }finally{await host.close();}
});

import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('CSS mutations preserve empty attributes and notify only actual declaration changes',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div style="color:red"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const e=document.querySelector('div'),s=e.style,o=new MutationObserver(()=>{}),r=[];o.observe(e,{attributes:true,attributeOldValue:true});
   r.push(s.removeProperty('color'),e.hasAttribute('style'),e.getAttribute('style'));r.push(o.takeRecords().map(x=>x.oldValue));
   s.removeProperty('absent');s.setProperty('color','not-a-color');r.push(o.takeRecords().length);
   s.setProperty('color','blue','IMPORTANT');r.push(s.color,s.getPropertyPriority('color'),o.takeRecords().map(x=>x.oldValue));
   s.setProperty('color','blue','important');r.push(o.takeRecords().length);
   s.setProperty('color','','invalid-priority');r.push(s.color,e.getAttribute('style'),o.takeRecords().length);
   s.cssText='';s.cssText='';r.push(o.takeRecords().length);o.disconnect();e.removeAttribute('style');s.removeProperty('color');r.push(e.hasAttribute('style'));return r;
  })()`)).toEqual(['red',true,'',['color:red'],0,'blue','important',[''],0,'','',1,2,false]);
 }finally{await host.close();}
});

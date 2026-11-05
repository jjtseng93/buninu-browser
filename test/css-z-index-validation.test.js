import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('z-index rejects invalid literals consistently without losing the prior declaration',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div style="z-index:7"></div><style>div{z-index:8;z-index:none}</style>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const el=document.querySelector('div'),s=el.style,o=new MutationObserver(()=>{}),r=[];o.observe(el,{attributes:true});
   for(const bad of ['invalid','none','10px','0.5','1.0','1e2','0x10','auto 123'])s.zIndex=bad;
   r.push(s.zIndex,o.takeRecords().length);
   s.cssText='z-index:9;z-index:invalid';r.push(s.zIndex);
   const rs=document.querySelector('style').sheet.cssRules[0].style;r.push(rs.zIndex);rs.setProperty('z-index','10px');r.push(rs.zIndex);
   s.zIndex='AUTO';r.push(s.zIndex);s.zIndex='-3';r.push(s.zIndex);s.setProperty('--layer','2');s.zIndex='var(--layer)';r.push(s.zIndex);
   s.zIndex='calc(3 - 2)';r.push(s.zIndex);o.disconnect();return r;
  })()`)).toEqual(['7',0,'9','8','8','auto','-3','var(--layer)','calc(3 - 2)']);
 }finally{await host.close();}
});

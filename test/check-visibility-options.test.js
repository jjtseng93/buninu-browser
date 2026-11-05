import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('checkVisibility observes requested opacity and box existence without hiding children of contents',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div id="parent" style="opacity:0"><span id="child">text</span></div><div id="contents" style="display:contents"><span id="visible">visible</span></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const p=document.getElementById('parent'),c=document.getElementById('child'),r=[c.checkVisibility(),c.checkVisibility({checkOpacity:true}),c.checkVisibility({opacityProperty:true}),document.getElementById('contents').checkVisibility(),document.getElementById('visible').checkVisibility()];p.style.opacity='.01';r.push(c.checkVisibility({checkOpacity:true}));p.style.visibility='hidden';r.push(c.checkVisibility(),c.checkVisibility({checkVisibilityCSS:true}));c.style.visibility='visible';r.push(c.checkVisibility({visibilityProperty:true}));p.style.display='none';r.push(c.checkVisibility());return r})()`)).toEqual([true,false,false,false,true,true,true,false,true,false]);
 }finally{await host.close();}
});

import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('Window.update coalesces requests and emits frame signals, including reentrant requests',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,window-update',contentType:'text/x-qml',source:`import QtQuick
import Quickshell
FloatingWindow {width:200;height:100
 Item {id:child;Component.onCompleted:globalThis.testWindow=child.Window.window}
}`});
  await host.call('whenLoaded');
  const result=await host.call('evaluate',`(()=>{
   const original=requestAnimationFrame, cancel=cancelAnimationFrame;
   const queue=new Map();let next=0,animated=0,synced=0;
   globalThis.requestAnimationFrame=fn=>{queue.set(++next,fn);return next};
   globalThis.cancelAnimationFrame=id=>queue.delete(id);
   const w=testWindow;
   const animate=()=>{animated++;if(animated===1)w.update()};
   const sync=()=>synced++;
   const step=()=>{const [id,fn]=queue.entries().next().value;queue.delete(id);fn(0)};
   try {
    w.update();w.update();const coalesced=queue.size;
    w.afterAnimating.connect(animate);w.afterSynchronizing.connect(sync);
    step();const reentrant=queue.size;
    step();
    w.afterAnimating.disconnect(animate);w.afterSynchronizing.disconnect(sync);
    step();const idle=queue.size;
    w.update();step();step();const idleAfterUnobserved=queue.size;
    return {coalesced,reentrant,animated,synced,idle,idleAfterUnobserved};
   }finally{globalThis.requestAnimationFrame=original;globalThis.cancelAnimationFrame=cancel}
  })()`);
  expect(result).toEqual({coalesced:1,reentrant:1,animated:2,synced:2,idle:0,idleAfterUnobserved:0});
 }finally{host.close()}
},30000);

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
  await Bun.sleep(100);
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

test('observing Window frame signals does not continuously animate an idle scene',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,idle-window',contentType:'text/x-qml',source:`import QtQuick
import Quickshell
FloatingWindow {id:window;width:200;height:100
 property int frames:0
 property int swaps:0
 onAfterAnimating:frames++
 onFrameSwapped:swaps++
 Rectangle {id:box;width:20;height:20;color:"red"}
 Component.onCompleted:globalThis.fixture={window:window,box:box}
}`});
  await host.call('whenLoaded');
  const run=s=>host.call('evaluate',s);
  const settled=async()=>{
   let last=-1;
   for(let i=0;i<30;i++){
    await Bun.sleep(30);
    const n=await run('fixture.window.frames');
    if(n===last)return n;
    last=n;
   }
   throw Error('Window did not become idle');
  };
  const before=await settled();expect(before).toBeGreaterThan(0);
  await Bun.sleep(100);expect(await run('fixture.window.frames')).toBe(before);
  expect(await run('fixture.window.swaps')).toBe(before);
  await run('fixture.box.color="blue"');
  expect(await settled()).toBeGreaterThan(before);
  const changed=await run('fixture.window.frames');
  await run('fixture.window.update()');
  expect(await settled()).toBeGreaterThan(changed);
 }finally{host.close()}
},30000);

test('nonvisual QML animations keep Window frame observers active until stopped',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,animated-window',contentType:'text/x-qml',source:`import QtQuick
import Quickshell
FloatingWindow {id:window;width:200;height:100;property int frames:0;property real counter:0
 onAfterAnimating:frames++
 FrameAnimation {id:clock;running:true}
 NumberAnimation {id:animation;target:window;property:"counter";from:0;to:1;duration:100;loops:Animation.Infinite;running:false}
 Component.onCompleted:globalThis.fixture={window:window,clock:clock,animation:animation}
}`});
  await host.call('whenLoaded');
  const run=s=>host.call('evaluate',s);
  let before=await run('fixture.window.frames');await Bun.sleep(150);
  expect(await run('fixture.window.frames')).toBeGreaterThan(before);
  await run('fixture.clock.running=false;fixture.animation.running=true');
  before=await run('fixture.window.frames');await Bun.sleep(150);
  expect(await run('fixture.window.frames')).toBeGreaterThan(before);
  await run('fixture.animation.running=false');await Bun.sleep(100);
  before=await run('fixture.window.frames');await Bun.sleep(100);
  expect(await run('fixture.window.frames')).toBe(before);
 }finally{host.close()}
},30000);

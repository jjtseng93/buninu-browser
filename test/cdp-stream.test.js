import { test, expect } from 'bun:test';
import { CdpServer } from '../lib/cdp-server.js';
import { CDP } from '../tools/browser-lab.js';
const until = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(5);}throw Error('condition timed out'); };
async function fixture(screenshot, context = {}) {
  let onFrame;
  const server=CdpServer.create({...context,screenshot,onFrame:fn=>{onFrame=fn;}}).listen(0);
  const cdp=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
  await cdp.ready;const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
  return {cdp,targetId,frame:info=>onFrame(info),frames:()=>cdp.events.filter(e=>e.method==='Page.screencastFrame'),close:()=>{cdp.close();server.stop(true);}};
}
test('slow screencast client gets at most two unacked frames; latest updates resume after ack',async()=>{
  let calls=0;const f=await fixture(async()=>String(++calls));
  try{
    await f.cdp.send('Page.startScreencast');await until(()=>f.frames().length===1);
    f.frame();await until(()=>f.frames().length===2);
    for(let i=0;i<50;i++)f.frame();await Bun.sleep(20);
    expect(calls).toBe(2);
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[0].params.sessionId});
    await until(()=>f.frames().length===3);expect(calls).toBe(3);
    await f.cdp.send('Page.screencastFrameAck',{sessionId:-1});f.frame();await Bun.sleep(10);expect(calls).toBe(3);
    await f.cdp.send('Page.stopScreencast');f.frame();await Bun.sleep(10);expect(calls).toBe(3);
    await f.cdp.send('Page.startScreencast');await until(()=>calls===4);
    f.cdp.close();await Bun.sleep(20);f.frame();await Bun.sleep(10);expect(calls).toBe(4);
  }finally{f.close();}
});
test('closing a target drops a capture already in flight',async()=>{
  let resolveCapture;const f=await fixture(()=>new Promise(resolve=>{resolveCapture=resolve;}));
  try{
    await f.cdp.send('Page.startScreencast');await until(()=>resolveCapture);
    await f.cdp.send('Target.closeTarget',{targetId:f.targetId});resolveCapture('obsolete');
    await Bun.sleep(20);expect(f.frames()).toHaveLength(0);
  }finally{f.close();}
});
test('clients without attached sessions receive updates and release their implicit stream on disconnect',async()=>{
  let calls=0;const f=await fixture(async()=>String(++calls));
  try{
    f.cdp.sessionId=null;
    await f.cdp.send('Page.startScreencast');await until(()=>f.frames().length===1);
    f.frame();await until(()=>f.frames().length===2);
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[0].params.sessionId});
    f.frame();await until(()=>f.frames().length===3);
    f.cdp.close();await Bun.sleep(20);f.frame();await Bun.sleep(10);expect(calls).toBe(3);
  }finally{f.close();}
});
test('stopping a capture in flight drops its frame and a restarted stream gets its own options',async()=>{
  const pending=[];const f=await fixture(params=>new Promise(resolve=>pending.push({params,resolve})));
  try{
    await f.cdp.send('Page.startScreencast',{format:'jpeg'});await until(()=>pending.length===1);
    await f.cdp.send('Page.stopScreencast');await f.cdp.send('Page.startScreencast',{format:'png'});
    pending[0].resolve('old');await until(()=>pending.length===2);expect(f.frames()).toHaveLength(0);
    expect(pending[1].params.format).toBe('png');pending[1].resolve('new');await until(()=>f.frames().length===1);
    expect(f.frames()[0].params.data).toBe('new');
  }finally{f.close();}
});

test('zero-area screencast notifies without capture, while screenshots retain clip validation',async()=>{
  const {captureViewport}=await import('../lib/paint/frame.js');
  let calls=0;
  const f=await fixture(options=>{
    calls++;
    if(options.clip?.width===0 || options.clip?.height===0)
      captureViewport(null,0,0,8,6,options.clip);
    return 'real-pixels';
  });
  const clip={x:0,y:0,width:0,height:0,scale:1};
  try{
    await f.cdp.send('Page.startScreencast',{format:'png',maxWidth:8,maxHeight:6,clip});
    await until(()=>f.frames().length===1);f.frame();await until(()=>f.frames().length===2);
    expect(calls).toBe(0);
    for(const {params} of f.frames()){
      const png=Buffer.from(params.data,'base64');expect(png.readUInt32BE(16)).toBe(1);expect(png.readUInt32BE(20)).toBe(1);
    }
    await expect(f.cdp.send('Page.captureScreenshot',{format:'png',clip})).rejects.toThrow('Invalid screenshot clip');
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[0].params.sessionId});
    f.frame();await until(()=>f.frames().length===3);expect(calls).toBe(1);
    await f.cdp.send('Page.stopScreencast');
    await f.cdp.send('Page.startScreencast',{format:'jpeg',clip:{...clip,width:8,height:6}});
    await until(()=>f.frames().length===4);expect(f.frames()[3].params.data).toBe('real-pixels');expect(calls).toBe(2);
  }finally{f.close();}
});

const zeroClip = {x:0,y:0,width:0,height:0,scale:1};
test('zero-area notifications reuse exact scroll snapshots and coalesce to the latest pending position',async()=>{
  let queries=0,captures=0;
  const f=await fixture(()=>{captures++;return 'pixels';},{scrollOffset:()=>{queries++;return {x:1,y:2};}});
  const offset=i=>f.frames()[i].params.metadata;
  try{
    await f.cdp.send('Page.startScreencast',{clip:zeroClip});await until(()=>f.frames().length===1);
    expect(queries).toBe(1);expect(offset(0)).toMatchObject({scrollOffsetX:1,scrollOffsetY:2});
    f.frame({scrollOffset:{x:10.25,y:20.75}});await until(()=>f.frames().length===2);
    expect(queries).toBe(1);expect(offset(1)).toMatchObject({scrollOffsetX:10.25,scrollOffsetY:20.75});
    const latest={scrollOffset:{x:23.5,y:49.75}};
    f.frame({scrollOffset:{x:12,y:30}});f.frame(latest);latest.scrollOffset.y=999;
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[0].params.sessionId});
    await until(()=>f.frames().length===3);
    expect(offset(2)).toMatchObject({scrollOffsetX:23.5,scrollOffsetY:49.75});expect(queries).toBe(1);
    // An unannotated/malformed update must replace, not inherit, older metadata.
    f.frame({scrollOffset:{x:1,y:NaN}});
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[1].params.sessionId});
    await until(()=>f.frames().length===4);
    expect(queries).toBe(2);expect(offset(3)).toMatchObject({scrollOffsetX:1,scrollOffsetY:2});
    expect(captures).toBe(0);
  }finally{f.close();}
});

test('pixel screencasts still query their capture position instead of using invalidation metadata',async()=>{
  let queries=0,captures=0;
  const f=await fixture(()=>String(++captures),{scrollOffset:()=>({x:0,y:++queries*100})});
  try{
    await f.cdp.send('Page.startScreencast',{format:'png'});await until(()=>f.frames().length===1);
    f.frame({scrollOffset:{x:99,y:99}});await until(()=>f.frames().length===2);
    expect(captures).toBe(2);expect(queries).toBe(2);
    expect(f.frames()[1].params.metadata).toMatchObject({scrollOffsetX:0,scrollOffsetY:200});
  }finally{f.close();}
});

test('screencast restart and document navigation do not reuse pending old scroll metadata',async()=>{
  let queries=0;
  const f=await fixture(()=>'',{scrollOffset:()=>({x:0,y:++queries})});
  try{
    await f.cdp.send('Page.startScreencast',{clip:zeroClip});await until(()=>f.frames().length===1);
    f.frame({scrollOffset:{x:10,y:20}});await until(()=>f.frames().length===2);
    f.frame({scrollOffset:{x:100,y:200}});
    await f.cdp.send('Page.navigate',{url:'https://replacement.test/'});
    await f.cdp.send('Page.screencastFrameAck',{sessionId:f.frames()[0].params.sessionId});
    await until(()=>f.frames().length===3);
    expect(f.frames()[2].params.metadata).toMatchObject({scrollOffsetX:0,scrollOffsetY:2});
    f.frame({scrollOffset:{x:1000,y:2000}});
    await f.cdp.send('Page.stopScreencast');
    await f.cdp.send('Page.startScreencast',{clip:zeroClip});await until(()=>f.frames().length===4);
    expect(f.frames()[3].params.metadata).toMatchObject({scrollOffsetX:0,scrollOffsetY:3});
    expect(queries).toBe(3);
  }finally{f.close();}
});

test('a scroll query crossing navigation is discarded before notifying the new document',async()=>{
  const pending=[];
  const f=await fixture(()=>'',{scrollOffset:()=>new Promise(resolve=>pending.push(resolve))});
  try{
    await f.cdp.send('Page.startScreencast',{clip:zeroClip});await until(()=>pending.length===1);
    await f.cdp.send('Page.navigate',{url:'https://next.test/'});
    f.frame({scrollOffset:{x:3,y:4}});
    pending[0]({x:90,y:100});await until(()=>f.frames().length===1);
    expect(f.frames()[0].params.metadata).toMatchObject({scrollOffsetX:3,scrollOffsetY:4});
    expect(pending).toHaveLength(1);
  }finally{f.close();}
});

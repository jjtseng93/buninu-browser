import { test, expect } from 'bun:test';
import { CdpServer } from '../lib/cdp-server.js';
import { CDP } from '../tools/browser-lab.js';
const until = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(5);}throw Error('condition timed out'); };
async function fixture(screenshot) {
  let onFrame;
  const server=CdpServer.create({screenshot,onFrame:fn=>{onFrame=fn;}}).listen(0);
  const cdp=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
  await cdp.ready;const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
  return {cdp,targetId,frame:()=>onFrame(),frames:()=>cdp.events.filter(e=>e.method==='Page.screencastFrame'),close:()=>{cdp.close();server.stop(true);}};
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

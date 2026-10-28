import {test,expect} from 'bun:test';
import {VideoPresentation} from '../lib/renderer/video-presentation.js';
const sleep=Bun.sleep;
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await sleep(2);}throw Error('timeout');};
function fixture({hold=false,changedFormat=false}={}){
 const reports=[],shown=[],decoders=[];let release,decodeCalls=0;
 const engine={async decode(bytes){
  const d={width:4,height:changedFormat&&bytes[0]>1?4:3,fps:10,at:0,calls:0,closed:0,
   seek(ms){this.at=Math.floor(ms/1000)*10;},
   nextFrame(w,h){this.calls++;if(this.at>=bytes[0]*10)return null;return new Uint8Array(w*h*4).fill(++this.at);},
   close(){this.closed++;}};
  decoders.push(d);decodeCalls++;if(hold&&bytes[0]>1)await new Promise(r=>release=r);return d;
 }};
 const v=new VideoPresentation(engine,()=>{shown.push({time:v.frame.time,value:v.frame.pixels[0]});v.frame.pixels.buffer.transfer(0);},r=>reports.push(r));
 const config={id:3,bytes:new Uint8Array([1]),options:{},time:0,audioId:4,audioStart:0,hasAudio:true,snapshotId:'a',generation:1,shared:new SharedArrayBuffer(16+480*480*4)};
 const start=async()=>{v.timing(4,0);await v.open(config);v.timing(4,.4);await wait(()=>reports.some(x=>x.exhaustedAt));};
 const request=()=>({id:3,revision:0,snapshotId:'a',generation:2,boundary:1,bytes:new Uint8Array([2,0])});
 return {v,reports,shown,decoders,start,request,release:()=>release(),calls:()=>decodeCalls};
}
test('continuation retains queued pixels, transfers once, and resumes at decoded boundary',async()=>{
 const f=fixture({hold:true});try{
 await f.start();const exhausted=f.reports.find(x=>x.exhaustedAt);
 expect(exhausted.exhaustedAt).toBeCloseTo(1,9);expect(f.v.queue.length).toBeGreaterThan(0);
 const pending=f.v.extend(f.request());await wait(()=>f.calls()===2);
 const before=f.shown.length;f.v.timing(4,.7);expect(f.shown.length).toBe(before+1);expect(f.shown.at(-1).time).toBeCloseTo(.7,9);
 expect(f.v.queue.length).toBeGreaterThan(0);f.release();expect(await pending).toBe(true);
 for(let i=8;i<=21;i++){f.v.timing(4,i/10);await sleep(12);expect(f.v.queue.length).toBeLessThanOrEqual(f.v.limit);}
 expect(new Set(f.shown.map(x=>x.value)).size).toBe(f.shown.length);
 expect(f.shown.every((x,i,a)=>i===0||x.time>a[i-1].time)).toBe(true);
 expect(f.shown.some(x=>x.value===11)).toBe(true);
 expect(f.v.config.audioId).toBe(4);expect(f.v.config.generation).toBe(2);
 expect(f.reports.filter(x=>x.end!==undefined)).toHaveLength(1);
 const calls=f.decoders.at(-1).calls;await sleep(35);expect(f.v.timer).toBeNull();expect(f.decoders.at(-1).calls).toBe(calls);
 }finally{f.v.stop();}
});
test('old id/revision/generation/configuration epoch requests cannot replace decoder',async()=>{
 const f=fixture();try{await f.start();for(const change of [{id:9},{revision:8},{generation:1},{snapshotId:'other'}])expect(await f.v.extend({...f.request(),...change})).toBe(false);expect(f.calls()).toBe(1);}finally{f.v.stop();}
});
test('pause or seek cancels a decoder opening without resurrecting old frames',async()=>{
 for(const openNew of [false,true]){const f=fixture({hold:true});try{
 await f.start();const pending=f.v.extend(f.request());await wait(()=>f.calls()===2);const staged=f.decoders[1];
 f.v.stop();if(openNew)await f.v.open({id:7,bytes:new Uint8Array([1]),options:{},time:0,audioId:8,audioStart:0,snapshotId:'b',generation:1});
 const before=f.shown.length;f.release();expect(await pending).toBe(false);expect(staged.closed).toBe(1);expect(f.shown.length).toBe(before);expect(f.v.config?.id??null).toBe(openNew?7:null);
 }finally{f.v.stop();}}
});
test('one in-progress continuation is bounded and changed codec geometry rejects safely',async()=>{
 const f=fixture({hold:true,changedFormat:true});try{await f.start();const pending=f.v.extend(f.request());await wait(()=>f.calls()===2);expect(await f.v.extend({...f.request(),generation:3})).toBe(false);expect(f.calls()).toBe(2);f.release();expect(await pending).toBe(false);expect(f.reports.some(x=>x.continuationError)).toBe(true);expect(f.v.config.generation).toBe(1);f.v.timing(4,1.1);await sleep(15);expect(f.reports.filter(x=>x.end!==undefined)).toHaveLength(1);}finally{f.v.stop();}
});
test('EOF without new bytes is reported once and does not poll/decode forever',async()=>{
 const f=fixture();try{await f.start();f.v.timing(4,1.1);await sleep(15);expect(f.reports.filter(x=>x.exhaustedAt!==undefined)).toHaveLength(1);expect(f.reports.filter(x=>x.end!==undefined)).toHaveLength(1);const count=f.decoders[0].calls;await sleep(35);expect(f.decoders[0].calls).toBe(count);expect(f.v.timer).toBeNull();}finally{f.v.stop();}
});
test('updated track boundary cancels pending continuation and never shows next epoch pixels',async()=>{
 const f=fixture({hold:true});try{await f.start();const pending=f.v.extend(f.request());await wait(()=>f.calls()===2);f.v.bind(3,undefined,undefined,undefined,.8);f.release();expect(await pending).toBe(false);f.v.timing(4,1.1);await sleep(15);expect(f.shown.every(x=>x.time<.8)).toBe(true);expect(f.reports.filter(x=>x.end!==undefined).map(x=>x.end)).toEqual([.8]);expect(f.v.config.generation).toBe(1);}finally{f.v.stop();}
});
test('clock binding updates survive continuation without resetting or extrapolating audio time',async()=>{
 const f=fixture({hold:true});try{await f.start();const pending=f.v.extend(f.request());await wait(()=>f.calls()===2);f.v.bind(3,8,.5);const before=f.shown.length;f.v.timing(4,9);expect(f.shown.length).toBe(before);f.v.timing(8,.2);expect(f.v.time()).toBe(.7);f.release();expect(await pending).toBe(true);expect(f.v.config.audioId).toBe(8);expect(f.v.config.audioStart).toBe(.5);expect(f.v.time()).toBe(.7);expect(f.v.config.time).toBe(0);}finally{f.v.stop();}
});

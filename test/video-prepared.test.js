import {test,expect} from 'bun:test';
import {VideoPresentation} from '../lib/renderer/video-presentation.js';
import {startVideoChannel} from '../lib/renderer/video-channel.js';

const until=async predicate=>{for(let i=0;i<200&&!predicate();i++)await Bun.sleep(10);expect(predicate()).toBe(true);};

test('prepared is a decoded-state notification, not a due-frame/audio-clock dependency',async()=>{
 let resolve,at=0;const reports=[],frames=[];
 const video=new VideoPresentation({decode:()=>new Promise(r=>resolve=r)},()=>frames.push(video.frame),r=>reports.push(r));
 try{
  const opening=video.open({id:1,time:0,hasAudio:true});
  expect(reports).toEqual([]);
  resolve({width:2,height:2,fps:4,get frameTime(){return at-.25;},get nextFrameTime(){return at;},
   nextFrame(){at+=.5;return new Uint8Array(16).fill(at*20);},close(){}});
  await opening;
  expect(video.prepared).toBe(true);expect(video.queue.length).toBeGreaterThan(0);
  expect(video.queue[0].time).toBe(.25);expect(video.frame).toBeNull();expect(frames).toEqual([]);
  expect(reports).toEqual([{id:1,revision:0,prepared:true}]);
  video.bind(1,7,0,0);video.timing(7,.25);
  expect(video.frame.time).toBe(.25);expect(frames).toHaveLength(1);
  await Bun.sleep(30);expect(reports.filter(r=>r.prepared)).toHaveLength(1);
 }finally{video.stop();}
});

test('preparation crosses a future track start and a gap after a discarded prefix without a running clock',async()=>{
 for(const prefix of [false,true]){
  let index=0,calls=0;const times=prefix?[0,3,3.25]:[2,2.25,2.5];const reports=[];
  const video=new VideoPresentation({decode:async()=>({width:2,height:2,fps:4,
   seek(){index=0;},get frameTime(){return times[index-1];},get nextFrameTime(){return times[index]??4;},
   nextFrame(w,h){calls++;index++;return new Uint8Array(w*h*4).fill(index);},close(){}})},()=>{},r=>reports.push(r));
  try{
   await video.open({id:8,time:prefix?1:0,startTime:prefix?0:2,hasAudio:true});
   expect(video.prepared).toBe(true);expect(video.frame).toBeNull();
   expect(video.queue).toHaveLength(1);expect(video.queue[0].time).toBe(prefix?3:2);
   expect(reports.filter(r=>r.prepared)).toHaveLength(1);
   const before=calls;await Bun.sleep(30);expect(calls).toBe(before);
  }finally{video.stop();}
 }
});

test('empty EOF releases preparation and a canceled/open failure cannot signal ready',async()=>{
 const reports=[];let closed=0;
 const video=new VideoPresentation({decode:async()=>({width:2,height:2,fps:4,nextFrame:()=>null,close(){closed++;}})},()=>{},r=>reports.push(r));
 try{
  await video.open({id:2,time:0,hasAudio:true});
  expect(video.prepared).toBe(true);expect(video.frame).toBeNull();
  expect(reports).toEqual([{id:2,end:0},{id:2,revision:0,prepared:true}]);
  video.stop();expect(video.prepared).toBe(false);
  video.engine={decode:async()=>{throw Error('decoder cannot open');}};
  await video.open({id:3,time:0,hasAudio:true});
  expect(reports.at(-1)).toEqual({id:3,error:'Error: decoder cannot open'});
  expect(reports.filter(r=>r.prepared)).toHaveLength(1);expect(closed).toBe(1);
 }finally{video.stop();}
});

test('synchronous EOF teardown does not publish readiness for a canceled presentation',async()=>{
 const reports=[];const video=new VideoPresentation({decode:async()=>({width:1,height:1,fps:1,nextFrame:()=>null,close(){}})},()=>{},r=>{reports.push(r);if(r.end===0)video.stop();});
 await video.open({id:4,time:0,hasAudio:true});
 expect(reports).toEqual([{id:4,end:0}]);expect(video.config).toBeNull();
});

test('synchronous prepared callback can stop or replace its decoder without scheduling the old turn',async()=>{
 for(const replace of [false,true]){
  let pending;const reports=[];
  const engine={decode:async()=>({width:1,height:1,fps:4,nextFrame:()=>new Uint8Array([1,2,3,255]),close(){}})};
  const video=new VideoPresentation(engine,()=>{},r=>{
   reports.push(r);
   if(r.id===1&&r.prepared){video.stop();if(replace)pending=video.open({id:2,time:0,hasAudio:true});}
  });
  try{
   await video.open({id:1,time:0,hasAudio:true});if(pending)await pending;
   expect(reports.some(r=>r.error)).toBe(false);
   expect(video.config?.id??null).toBe(replace?2:null);
   expect(video.prepared).toBe(replace);
   expect(reports.filter(r=>r.prepared)).toHaveLength(replace?2:1);
  }finally{video.stop();}
 }
});

test('real worker/WASM prepares before any audio binding and preserves public frame ownership',async()=>{
 const reports=[];const channel=await startVideoChannel(()=>{},r=>reports.push(r));
 try{
  const bytes=await Bun.file(new URL('./fixtures/long-video.mp4',import.meta.url)).bytes();
  channel.open({id:11,bytes,time:0,hasAudio:true});
  await until(()=>reports.some(r=>r.prepared));
  expect(reports.find(r=>r.prepared)).toEqual({id:11,revision:0,prepared:true});
  const first=channel.frame;expect(first.time).toBe(0);
  expect(first.pixels.length).toBe(first.width*first.height*4);
  await Bun.sleep(30);expect(channel.frame).toBe(first);
  channel.bind(11,77,0,0);channel.timing(77,.5);
  await until(()=>channel.frame.time===.5);
  expect(first.pixels.length).toBe(first.width*first.height*4);
  expect(reports.filter(r=>r.prepared)).toHaveLength(1);
  expect(reports.some(r=>r.error)).toBe(false);
 }finally{channel.stop();channel.worker.terminate();}
},15000);

for(const mode of ['delayed','sync','pause','seek','hidden','removed','rotated','error','error-local','eof','navigate','source','dispose','late-audio','real-worker'])test(`new audio waits for prepared video: ${mode}`,async()=>{
 const file=mode==='late-audio'?'media-video-late-audio.js':'media-video-prepared.js';
 const child=Bun.spawn([process.execPath,new URL('./fixtures/'+file,import.meta.url).pathname,mode],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout).pass).toBe(true);
},30000);

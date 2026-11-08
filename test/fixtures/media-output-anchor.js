// Isolated process: host scripting installs browser globals.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {VideoPresentation} from '../../lib/renderer/video-presentation.js';
const mode=process.argv[2]??'audio', videoMode=mode!=='audio';
const messages=[], outputs=[], errors=[], observations=[];
const sleep=Bun.sleep;
let videoDecodes=0, audioDecodes=0;
const engine={
  probe:async()=>({duration:20,...(videoMode?{video:{width:20,height:12}}:{}),audio:{sampleRate:1000}}),
  decode:async()=>{videoDecodes++;let time=0;return {width:20,height:12,fps:10,
    seek(ms){time=Math.floor(ms/1000);},close(){},
    nextFrame(w,h){const pixels=new Uint8Array(w*h*4);for(let i=0;i<pixels.length;i+=4)pixels.set([Math.round(time*10)%255,40,80,255],i);time+=0.1;return pixels;}};},
  decodeAudio:async()=>{audioDecodes++;return {sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}};},
};
let renderer;
const presentation=mode==='presentation'?new VideoPresentation(engine,()=>{},report=>renderer.videoReport(report)):null;
const rendererOptions={
  fetchResource:async()=>({ok:true,body:new Uint8Array([1]),contentType:videoMode?'video/mp4':'audio/mp4'}),
  reportError:error=>errors.push(String(error)),videoDecoder:engine,
  audio:{
    open(options,listener){outputs.push({listener,sent:0,closed:false});return outputs.length;},
    write(id,bytes){outputs[id-1].sent+=bytes.length/2;},
    close(id){outputs[id-1].closed=true;return Promise.resolve(outputs[id-1].sent*2);},finish(){},
  },
};
if(presentation)Object.assign(rendererOptions,{onFrame(){},onVideo(message){
  messages.push(message);
  if(message.type==='video-open')void presentation.open(message);
  else if(message.type==='video-stop')presentation.stop(message.id);
  else if(message.type==='video-bind')presentation.bind(message.id,message.audioId,message.audioStart,message.time,message.endTime);
}});
renderer=await createPageRenderer(rendererOptions);
const evaluate=code=>renderer.evaluate(code);
const clock=async(label)=>{const time=await evaluate('m.currentTime');observations.push({label,time});return time;};
const signal=(index,event)=>{if(event.event==='timing')presentation?.timing(index+1,event.seconds);outputs[index].listener(event);};
const request=(index,frames)=>signal(index,{event:'request',bytes:frames*2});
const timing=(index,seconds)=>signal(index,{event:'timing',seconds,sentSeconds:outputs[index].sent/1000,sinkSeconds:0});
const waitFor=async(condition,label)=>{const end=Date.now()+3000;while(!await condition()){assert(Date.now()<end,`timed out ${label}`);await sleep(5);}};
const expectClock=async(label,want)=>assert.equal(await clock(label),want,label);
try{
  renderer.resize(240,180,1);renderer.setScripting('host');
  const tag=videoMode?'video':'audio';
  await renderer.loadDocument({url:'https://media-anchor.test/',contentType:'text/html',source:`<style>video{display:block;width:100px;height:60px}</style><${tag} id=m src="clip.mp4"></${tag}>`});
  await renderer.whenLoaded();
  await evaluate('globalThis.m=document.getElementById("m");globalThis.seekedCount=0;m.addEventListener("seeked",()=>seekedCount++);m.play()');
  await expectClock('initial stream before ready',0);
  signal(0,{event:'ready'});
  await expectClock('initial ready without timing',0);
  request(0,1000);timing(0,0.2);
  await expectClock('first stream measured progress',0.2);
  if(presentation)await waitFor(()=>messages.some(m=>m.type==='video-open'),'initial presentation');
  await evaluate('m.pause()');
  await expectClock('paused at last measured time',0.2);
  timing(0,0.95);
  await expectClock('late closed-stream timing ignored',0.2);
  await sleep(30);
  await expectClock('paused time does not extrapolate',0.2);
  const beforeResumeDecoder=audioDecodes;
  await evaluate('m.play()');
  await waitFor(()=>outputs.length===2,'prepared resume output stream');
  assert.equal(outputs.length,2,'resume creates exactly one new output stream');
  assert.equal(audioDecodes,beforeResumeDecoder,'resume reuses retained decoded PCM');
  await expectClock('resume before first timing uses new stream anchor',1);
  await sleep(550);
  await expectClock('resume timer safety net does not extrapolate',1);
  signal(1,{event:'ready'});
  await expectClock('resume ready without timing holds anchor',1);
  request(1,500);
  await expectClock('PCM submission is not clock progress',1);
  await sleep(35);
  await expectClock('resume with no timing does not extrapolate',1);
  timing(0,4);
  await expectClock('old stream timing cannot overwrite resumed anchor',1);
  timing(1,0);
  await expectClock('first new-stream timing starts at anchor',1);
  timing(1,0.1);
  await expectClock('new stream measured progress',1.1);
  if(presentation){
    await waitFor(()=>messages.filter(m=>m.type==='video-open').length>=2,'resumed presentation');
    const opened=messages.filter(m=>m.type==='video-open').at(-1);
    assert.equal(opened.audioId,2);assert.equal(opened.audioStart,1);assert(opened.time>=1);
    await waitFor(()=>presentation.frame!==null,'resumed presentation pixels');
    assert.equal(presentation.time(),1.1,'presentation uses the same measured stream anchor');
  }
  // An explicit seek is allowed to move time, but a retained old stream
  // observation must never override the newly positioned stream's anchor.
  const seek=async(target,index)=>{
    const count=audioDecodes;
    const seeksBefore=await evaluate('seekedCount');
    await evaluate(`m.currentTime=${target}`);
    await waitFor(()=>outputs.length===index+1,'seek output stream');
    await waitFor(async()=>await evaluate('seekedCount')>seeksBefore,'playing seek');
    assert.equal(audioDecodes,count,'seek within PCM history reuses decoder');
    await expectClock(`seek ${target} before first timing`,target);
    signal(index,{event:'ready'});
    await expectClock(`seek ${target} ready before first timing`,target);
    timing(index-1,9);
    await expectClock(`seek ${target} ignores previous stream feedback`,target);
    timing(index,0);
    await expectClock(`seek ${target} first feedback starts at anchor`,target);
  };
  await seek(1.3,2);
  request(2,500);timing(2,0.2);
  await expectClock('progress before backwards seek',1.5);
  await seek(1.4,3);
  request(3,300);timing(3,0.1);
  await expectClock('backwards seek resumes measured progress',1.5);
  await evaluate('m.pause()');
  await expectClock('second pause holds measured progress',1.5);
  const seeksBefore=await evaluate('seekedCount');
  await evaluate('m.currentTime=1.6');
  await waitFor(async()=>await evaluate('seekedCount')>seeksBefore,'paused seek');
  await expectClock('paused seek position is authoritative',1.6);
  assert.equal(outputs.length,4,'paused seek does not create an output stream');
  await evaluate('m.play()');
  await waitFor(()=>outputs.length===5,'prepared paused-seek output stream');
  assert.equal(outputs.length,5);
  await expectClock('play after paused seek holds sought anchor',1.6);
  signal(4,{event:'ready'});timing(4,0);
  await expectClock('paused seek first timing is continuous',1.6);
  assert.deepEqual(errors,[]);
  process.stdout.write(JSON.stringify({ok:true,mode,audioDecodes,videoDecodes,streams:outputs.length,observations})+'\n');
}finally{presentation?.stop();renderer.dispose();}

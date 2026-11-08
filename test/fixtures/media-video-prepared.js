// Isolated: the host realm replaces browser globals. Audio output is a measured
// mock sink; real-worker additionally uses the actual Worker and WASM codecs.
import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {startVideoChannel} from '../../lib/renderer/video-channel.js';
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';
const mode=process.argv[2],real=mode==='real-worker';
const messages=[],outputs=[],reports=[],errors=[];let renderer,channel,holdReports=false,heldReports=[];
let bytes=new Uint8Array(1024),audioBytes;
if(real){await wasmpeg.load();bytes=await Bun.file(new URL('./long-video.mp4',import.meta.url)).bytes();audioBytes=await Bun.file(new URL('./mse-audio-chirp.webm',import.meta.url)).bytes();}
const deliver=report=>{reports.push(report);if(holdReports)heldReports.push(report);else renderer.videoReport(report);};
if(real)channel=await startVideoChannel(()=>{},deliver);
const send=message=>{
 messages.push(message);
 if(channel){
  if(message.type==='video-open')channel.open(message);
  else if(message.type==='video-stop')channel.stop(message.id);
  else if(message.type==='video-bind')channel.bind(message.id,message.audioId,message.audioStart,message.time,message.endTime);
 }else if(message.type==='video-open'&&(messages.filter(m=>m.type==='video-open').length===1||mode==='sync'))renderer.videoReport({id:message.id,prepared:true});
};
let localFrames=0,failLocalSeek=false;
const videoDecoder=real?{probe:async b=>({...await wasmpeg.probe(b),audio:{sampleRate:48000,channels:1}}),decode:(b,o)=>wasmpeg.decode(b,o),decodeAudio:()=>wasmpeg.decodeAudio(audioBytes,{format:'webm'})}:{
 probe:async()=>({duration:30,video:{width:20,height:12},audio:{sampleRate:1000,channels:1}}),
 decode:async()=>{let at=0;return{width:20,height:12,fps:10,seek(ms){if(failLocalSeek)throw Error('local seek failed');at=Math.floor(ms/1000);},nextFrame(w,h){localFrames++;at+=.1;const p=new Uint8Array(w*h*4);for(let i=0;i<p.length;i+=4){p[i]=90;p[i+3]=255;}return p;},close(){}};},
 decodeAudio:async()=>({sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}}),
};
renderer=await createPageRenderer({onFrame(){},onVideo:send,videoDecoder,
 fetchResource:async()=>({ok:true,contentType:'video/mp4',body:bytes}),reportError:e=>errors.push(String(e)),
 audio:{open(options,listener){outputs.push({listener,samples:0,options});return outputs.length;},write(id,pcm){outputs[id-1].samples+=pcm.length/2;},close(id){return Promise.resolve(outputs[id-1].samples*2);},finish(){}}});
const ev=s=>renderer.evaluate(s),opens=()=>messages.filter(m=>m.type==='video-open');
const wait=async predicate=>{for(let i=0;i<250&&!predicate();i++)await Bun.sleep(10);assert(predicate(),'timeout '+JSON.stringify({mode,outputs:outputs.length,messages:messages.map(m=>[m.type,m.id]),reports,errors}));};
const timing=(id,seconds)=>{outputs[id-1].listener({event:'timing',seconds,sentSeconds:seconds+.1,sinkSeconds:.1});channel?.timing(id,seconds);};
try{
 renderer.resize(240,180,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://prepared.test/',contentType:'text/html',source:'<style>body{margin:0}video{display:block;width:100px;height:60px}</style><video id=v src="clip.mp4"></video>'});
 await renderer.whenLoaded();await ev('window.v=document.getElementById("v");window.events=[];v.addEventListener("playing",()=>events.push("playing"));v.play()');
 assert.equal(outputs.length,1);
 outputs[0].listener({event:'request',bytes:real?19200:1000});
 await wait(()=>opens().length===1);
 if(real)await wait(()=>reports.some(r=>r.prepared));
 else renderer.videoReport({id:opens()[0].id,time:.2});
 timing(1,.2);await ev('v.pause()');
 const anchor=outputs[0].samples/outputs[0].options.channels/outputs[0].options.rate;
 holdReports=real;
 await ev('events.length=0;v.play()');
 const pending=opens().at(-1);assert.notEqual(pending.id,opens()[0].id);
 if(mode==='sync'){
  assert.equal(outputs.length,2,'early ready remains observable before the waiter is installed');
 }else{
  assert.equal(outputs.length,1,'no new output/PCM before decoded readiness');
  assert.equal(await ev('v.currentTime'),Math.max(.2,anchor));
  assert.deepEqual(await ev('events'),[],'playing is not dispatched while preparing');
  renderer.videoReport({id:opens()[0].id,prepared:true});renderer.videoReport({id:pending.id,revision:99,prepared:true});
  assert.equal(outputs.length,1,'wrong presentation/revision cannot release audio');
  if(mode==='delayed'){
   await Bun.sleep(550);assert.equal(outputs.length,1,'audio readiness timeout cannot bypass video preparation');
   assert.equal(await ev('v.currentTime'),Math.max(.2,anchor));
  }
  if(mode==='pause'){
   await ev('v.pause()');renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,1);
   await ev('v.play()');renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,1);
   renderer.videoReport({id:opens().at(-1).id,prepared:true});
  }else if(mode==='seek'){
   await ev('v.currentTime=2');await wait(()=>outputs.length===2);
   renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,2);
  }else if(['hidden','removed','rotated'].includes(mode)){
   await ev(mode==='hidden'?'v.style.display="none"':mode==='removed'?'v.remove()':'v.style.transform="rotate(10deg)"');
   renderer.inspect('body');await wait(()=>outputs.length===2);
   renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,2);
  }else if(mode==='error-local'){
   failLocalSeek=true;renderer.videoReport({id:pending.id,error:'test worker failure'});
   await wait(()=>errors.length===1);
   assert.equal(outputs.length,1);assert.equal(await ev('v.paused'),true);
   assert.equal(await ev('v.error.code'),3);renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,1);
   assert(errors[0].includes('local seek failed'));
   process.stdout.write(JSON.stringify({pass:true,mode})+'\n');process.exit(0);
  }else if(mode==='error'){
   renderer.videoReport({id:pending.id,error:'test worker failure'});await wait(()=>outputs.length===2);
  }else if(mode==='eof'){
   renderer.videoReport({id:pending.id,end:Math.max(.2,anchor)});await wait(()=>outputs.length===2);
  }else if(mode==='dispose'){
   renderer.dispose();renderer.videoReport({id:pending.id,prepared:true});await Bun.sleep(20);
   assert.equal(outputs.length,1);process.stdout.write(JSON.stringify({pass:true,mode})+'\n');process.exit(0);
  }else if(mode==='source'){
   await ev('v.src="other.mp4"');renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,1);
   await ev('v.play()');assert.equal(outputs.length,2);
   renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,2);
   await ev('v.pause()');process.stdout.write(JSON.stringify({pass:true,mode})+'\n');process.exit(0);
  }else if(mode==='navigate'){
   await renderer.loadDocument({url:'https://prepared.test/next',contentType:'text/html',source:'<p>next</p>'});
   renderer.videoReport({id:pending.id,prepared:true});await Bun.sleep(20);assert.equal(outputs.length,1);
   process.stdout.write(JSON.stringify({pass:true,mode})+'\n');process.exit(0);
  }else if(real){
   await wait(()=>heldReports.some(r=>r.id===pending.id&&r.prepared));
   assert.equal(outputs.length,1,'real Worker has decoded while renderer intentionally has not received readiness');
   holdReports=false;for(const report of heldReports.splice(0))renderer.videoReport(report);
  }else renderer.videoReport({id:pending.id,prepared:true});
 }
 await wait(()=>outputs.length===2);
 renderer.videoReport({id:pending.id,prepared:true});assert.equal(outputs.length,2,'duplicate readiness cannot open another stream');
 outputs[1].listener({event:'ready'});timing(2,.1);
 const time=await ev('v.currentTime');assert(time>=.1);
 if(!['hidden','removed','rotated','error','eof','seek'].includes(mode)){
  const bind=messages.filter(m=>m.type==='video-bind'&&m.id===opens().at(-1).id).at(-1);assert(bind);assert.equal(bind.audioId,2);
  assert.equal(bind.audioStart,Math.max(.2,anchor));
  if(real){await wait(()=>channel.frame?.time>=.25);assert.equal(channel.frame.pixels.length,channel.frame.width*channel.frame.height*4);}
 }
 assert.deepEqual(errors,[]);await ev('v.pause()');
 process.stdout.write(JSON.stringify({pass:true,mode,outputs:outputs.length,anchor,time,localFrames})+'\n');
}finally{renderer.dispose();channel?.stop();channel?.worker.terminate();}

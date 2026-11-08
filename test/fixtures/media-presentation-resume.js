// Isolated: host scripting installs browser globals.
import assert from 'node:assert/strict';
const mode=process.argv[2]??'visible';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createBytePipe} from '../../lib/media/byte-pipe.js';
const pipe=createBytePipe();pipe.append(new Uint8Array(1024));let epoch=1;
pipe.snapshotAt=()=>({id:epoch,startTime:0,endTime:Infinity,bytes:pipe.bytes()});
const decoders=[],messages=[],outputs=[],errors=[];
const renderer=await createPageRenderer({onFrame(){},onVideo:message=>messages.push(message),
 fetchResource:async()=>({ok:true,contentType:'video/mp4',body:mode.startsWith('file')?new Uint8Array(1024):pipe}),reportError:e=>errors.push(String(e)),
 videoDecoder:{probe:async()=>({duration:30,video:{width:20,height:12},audio:{sampleRate:1000}}),
 async decode(){const record={seeks:[],frames:0,at:0};decoders.push(record);return{width:20,height:12,fps:10,
 seek(ms){record.seeks.push(ms);record.at=Math.floor(ms/1000);},
 nextFrame(w,h){record.frames++;const pixels=new Uint8Array(w*h*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=20+Math.floor(record.at);pixels[i+3]=255;}record.at+=.1;return pixels;},close(){}};},
 decodeAudio:async()=>({sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}})},
 audio:{open(options,listener){outputs.push({listener,samples:0});return outputs.length;},write(id,bytes){outputs[id-1].samples+=bytes.length/2;},close(id){return Promise.resolve(outputs[id-1].samples*2);},finish(){}}});
const evaluate=code=>renderer.evaluate(code),opens=()=>messages.filter(m=>m.type==='video-open');
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await Bun.sleep(5);}assert.fail('wait timeout '+fn+' '+JSON.stringify({errors,decoders,messages:messages.map(({type,id})=>({type,id}))}));};
try{
 renderer.resize(240,180,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://resume.test/',contentType:'text/html',source:'<style>body{margin:0}video{display:block;width:100px;height:60px}#second{display:none}</style><video id=v src="clip.mp4"></video><video id=second></video>'});
 await renderer.whenLoaded();await evaluate('window.v=document.getElementById("v");v.play()');
 outputs.at(-1).listener({event:'request',bytes:2000});await wait(()=>opens().length===1);
 const first=opens()[0];
 // Simulate a real coherent worker picture and report, retained on pause.
 const meta=new Int32Array(first.shared,0,4),pixels=new Uint8Array(first.shared,16,20*12*4);
 for(let i=0;i<pixels.length;i+=4){pixels[i]=77;pixels[i+3]=255;}
 Atomics.store(meta,1,20);Atomics.store(meta,2,12);Atomics.store(meta,0,2);
 renderer.videoReport({id:first.id,time:.4});outputs[0].listener({event:'timing',seconds:.4,sentSeconds:1,sinkSeconds:.6});
 await evaluate('v.pause()');assert.equal(await evaluate('v.currentTime'),.4);
 if(mode!=='unchanged'&&!mode.startsWith('file'))pipe.append(new Uint8Array(1024));
 if(mode==='hidden')await evaluate('v.style.display="none"');
 if(mode==='removed')await evaluate('v.remove()');
 if(mode==='rotated')await evaluate('v.style.transform="rotate(10deg)"');
 if(mode==='multiple')await evaluate('document.getElementById("second").style.display="block"');
 if(mode==='epoch')epoch=2;
 if(mode==='backward'||mode==='forward'){
  await evaluate(`v.currentTime=${mode==='backward'?.1:2}`);await Bun.sleep(30);
 }
 const framesBefore=decoders.reduce((n,d)=>n+d.frames,0),seeksBefore=decoders.reduce((n,d)=>n+d.seeks.length,0),opensBefore=opens().length;
 const at=performance.now();await evaluate('v.play()');const playMs=performance.now()-at;
 const beforeReady={frames:decoders.reduce((n,d)=>n+d.frames,0)-framesBefore,seeks:decoders.reduce((n,d)=>n+d.seeks.length,0)-seeksBefore,opens:opens().length-opensBefore};
 const expectedTarget=mode==='backward'?.1:mode==='forward'?2:1;
 if(mode==='visible'||mode==='unchanged'||mode.startsWith('file')){
  const retained=await evaluate('(()=>{const c=document.createElement("canvas");c.width=20;c.height=12;const x=c.getContext("2d");x.drawImage(v,0,0);return Array.from(x.getImageData(0,0,1,1).data)})()');
  assert.deepEqual(retained,[77,0,0,255],'the full last worker picture remains available while restarting');
 }

 assert.equal(await evaluate('v.currentTime'),expectedTarget,'correct audio anchor even before ready');
 outputs.at(-1).listener({event:'ready'});await Bun.sleep(30);
 const isEligible=['visible','unchanged','file','file-eof','backward','forward'].includes(mode);
 if(mode==='visible'||mode==='unchanged'||mode.startsWith('file')){
  assert.equal(beforeReady.frames,0,'same-epoch resume must not decode local prefix');assert.equal(beforeReady.seeks,0);
  assert(beforeReady.opens>=1,'new worker request precedes audio readiness');
 }
 if(isEligible){
  assert(opens().length>=opensBefore+1);
  const last=opens().at(-1);assert.equal(last.time,expectedTarget);
  const bind=messages.filter(m=>m.type==='video-bind'&&m.id===last.id).at(-1);assert(bind);assert.equal(bind.audioId,2);assert.equal(bind.audioStart,expectedTarget);assert.equal(bind.time,expectedTarget);
 }else{
  assert(decoders.reduce((n,d)=>n+d.seeks.length,0)>seeksBefore,'ineligible/new epoch resume positions local decoder');
  assert(decoders.reduce((n,d)=>n+d.frames,0)>framesBefore,'ineligible/new epoch retains local rendering');
  if(mode!=='epoch')assert.equal(opens().length,opensBefore,'current layout must prevent presentation');
 }
 outputs.at(-1).listener({event:'timing',seconds:.2,sentSeconds:.4,sinkSeconds:.2});
 assert.equal(await evaluate('v.currentTime'),expectedTarget+.2,'measured audio remains clock');
 if(mode==='file-eof'){
  const last=opens().at(-1),m=new Int32Array(last.shared,0,4),p=new Uint8Array(last.shared,16,20*12*4);
  for(let y=0;y<12;y++)for(let x=0;x<20;x++){const i=(y*20+x)*4;p[i]=211+x%3;p[i+1]=y;p[i+3]=255;}
  Atomics.store(m,1,20);Atomics.store(m,2,12);Atomics.store(m,0,2);
  renderer.videoReport({id:last.id,time:29.9});
  outputs.at(-1).listener({event:'timing',seconds:28.9,sentSeconds:29,sinkSeconds:.1});
  renderer.videoReport({id:last.id,end:30});outputs.at(-1).listener({event:'ended'});
  assert.equal(await evaluate('v.ended'),true);
  const final=await evaluate('(()=>{const c=document.createElement("canvas");c.width=20;c.height=12;const x=c.getContext("2d");x.drawImage(v,0,0);return Array.from(x.getImageData(19,11,1,1).data)})()');
  assert.deepEqual(final,[212,11,0,255],'EOF retains full final worker picture');
 }
 await evaluate('v.pause()');const paused=await evaluate('v.currentTime');
 outputs.at(-1).listener({event:'timing',seconds:.4,sentSeconds:.4,sinkSeconds:0});assert.equal(await evaluate('v.currentTime'),paused);
 assert.deepEqual(errors,[]);
 process.stdout.write(JSON.stringify({pass:true,mode,playMs,beforeReady,decoders:decoders.length,opens:opens().length,expectedTarget})+"\n");
}finally{renderer.dispose();}

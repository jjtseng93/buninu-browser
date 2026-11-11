// Isolated realm: exercise renderer and compositor clocks together.
import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {VideoPresentation} from '../../lib/renderer/video-presentation.js';
const mode=process.argv[2]||'opening';
const outputs=[],messages=[],errors=[];
let renderer,shown=0;
const engine={
 probe:async()=>({duration:20,video:{width:20,height:12},audio:{sampleRate:1000,channels:1}}),
 decode:async()=>({width:20,height:12,fps:10,seek(){},close(){},nextFrame(w,h){return new Uint8Array(w*h*4).fill(255);}}),
 decodeAudio:async()=>({sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}}),
};
const presentation=new VideoPresentation(engine,()=>shown++,report=>renderer.videoReport(report));
renderer=await createPageRenderer({onFrame(){},videoDecoder:engine,
 fetchResource:async()=>({ok:true,body:new Uint8Array([1]),contentType:'video/mp4'}),reportError:e=>errors.push(String(e)),
 onVideo(m){messages.push(m);if(m.type==='video-open')void presentation.open(m);
 else if(m.type==='video-stop')presentation.stop(m.id);
 else if(m.type==='video-bind')presentation.bind(m.id,m.audioId,m.audioStart,m.time,m.endTime,m.hasAudio);},
 audio:{open(_o,listener){outputs.push(listener);return outputs.length;},write(){},close(){return 0;},finish(){}}});
const ev=s=>renderer.evaluate(s);
const wait=async f=>{for(let i=0;i<300;i++){if(await f())return;await Bun.sleep(10);}throw Error('timeout '+JSON.stringify({mode,shown,errors}));};
try{
 renderer.resize(240,180,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://output-failure.test/',contentType:'text/html',source:'<video id=v src="clip.mp4" width=100 height=60></video>'});
 await renderer.whenLoaded();await ev('globalThis.v=document.getElementById("v");v.play()');
 await wait(()=>outputs.length===1);
 if(mode==='playing'){
  outputs[0]({event:'ready'});presentation.timing(1,2);
  outputs[0]({event:'timing',seconds:2,sentSeconds:2.1});
 }
 const anchor=await ev('v.currentTime');
 outputs[0]({event:'error',message:'connection refused'});
 await wait(()=>presentation.config?.hasAudio===false);
 assert.equal(presentation.config.audioId,null);
 assert(Math.abs(presentation.config.time-anchor)<0.03,'fallback must preserve measured position');
 const before=shown;
 await wait(async()=>shown>before+1&&(await ev('v.currentTime'))>anchor+0.2);
 assert.equal(await ev('v.paused'),false);
 // Old device feedback must not reclaim the failed stream's clock.
 presentation.timing(1,19);outputs[0]({event:'timing',seconds:19,sentSeconds:19});
 assert((await ev('v.currentTime'))<anchor+2);
 if(mode==='recreated'){
  const oldId=presentation.config.id;
  await ev('v.style.display="none"');await wait(()=>!presentation.config);
  await ev('v.style.display="block"');await wait(()=>presentation.config&&presentation.config.id!==oldId);
  assert.equal(presentation.config.hasAudio,false,'new video-open must retain failed-output state');
  assert.equal(presentation.config.audioId,null);
  const time=presentation.time();await Bun.sleep(60);
  assert(presentation.time()>time+0.03,'replacement presentation must retain silent clock');
 }
 assert.equal(errors.length,1);
 process.stdout.write(JSON.stringify({pass:true,mode,shown,anchor})+'\n');
}finally{presentation.stop();renderer.dispose();}

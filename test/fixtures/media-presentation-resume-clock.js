// Isolated: host scripting installs browser globals.
import assert from 'node:assert/strict';
const mode=process.argv[2];
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const withAudio=mode==='audio-done',messages=[],outputs=[],errors=[],decoders=[],order=[];
const renderer=await createPageRenderer({onFrame(){},onVideo:m=>{messages.push(m);order.push(m.type);},
 fetchResource:async()=>({ok:true,contentType:'video/mp4',body:new Uint8Array(1024)}),reportError:e=>errors.push(String(e)),
 videoDecoder:{probe:async()=>({duration:5,video:{width:2,height:2},...(withAudio?{audio:{sampleRate:1000}}:{})}),
 async decode(){const d={frames:0,seeks:0,at:0};decoders.push(d);return{width:2,height:2,fps:10,seek(ms){d.seeks++;d.at=Math.floor(ms/1000);order.push('seek');},nextFrame(w,h){d.frames++;d.at+=.1;order.push('draw');const p=new Uint8Array(w*h*4);for(let i=0;i<p.length;i+=4){p[i]=Math.min(250,d.frames*10);p[i+3]=255;}return p;},close(){}};},
 decodeAudio:async()=>({sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}})},
 audio:{open(o,listener){outputs.push({listener,samples:0});return outputs.length;},write(id,bytes){outputs[id-1].samples+=bytes.length/2;},close(id){return Promise.resolve(outputs[id-1].samples*2);},finish(){}}});
const ev=s=>renderer.evaluate(s),wait=async f=>{for(let i=0;i<100;i++){if(f())return;await Bun.sleep(5);}assert.fail('timeout');};
try{
 renderer.resize(100,80,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://resume-clock.test/',contentType:'text/html',source:'<video id=v src="clip.mp4" width=20 height=20></video>'});
 await renderer.whenLoaded();await ev('window.v=document.getElementById("v");v.play()');
 if(withAudio)outputs[0].listener({event:'request',bytes:1000});
 await wait(()=>messages.some(m=>m.type==='video-open'));
 const id=messages.filter(m=>m.type==='video-open').at(-1).id;
 if(withAudio){renderer.videoReport({id,time:.2});outputs[0].listener({event:'timing',seconds:.2,sentSeconds:.5,sinkSeconds:.3});outputs[0].listener({event:'ended'});}
 await ev('v.pause()');
 const before={frames:decoders.reduce((n,d)=>n+d.frames,0),seeks:decoders.reduce((n,d)=>n+d.seeks,0),outputs:outputs.length},paused=await ev('v.currentTime');
 order.length=0;await ev('v.play()');
 if(withAudio){assert(!order.includes('video-open'),'completed audio must not enable early presentation');outputs.at(-1).listener({event:'ready'});}
 assert(decoders.reduce((n,d)=>n+d.seeks,0)>before.seeks,'silent/ended-audio resumes retain local seek');
 assert(decoders.reduce((n,d)=>n+d.frames,0)>before.frames,'silent/ended-audio resumes retain first local frame');
 assert(order.indexOf('seek')<order.indexOf('video-open'));
 assert(order.indexOf('draw')<order.indexOf('video-open'));
 if(!withAudio)assert.equal(outputs.length,before.outputs);
 const next=await ev('v.currentTime');assert(next>=Math.round(paused*1000)/1000&&next<paused+.3);
 await ev('v.pause()');assert.deepEqual(errors,[]);
 process.stdout.write(JSON.stringify({pass:true,mode,paused,next,order})+'\n');
}finally{renderer.dispose();}

import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createBytePipe} from '../../lib/media/byte-pipe.js';
const pipe=createBytePipe();pipe.append(new Uint8Array(1024));
const messages=[],outputs=[],errors=[];let available=false,openedAudio=0;
const renderer=await createPageRenderer({onFrame(){},onVideo:m=>messages.push(m),
 fetchResource:async()=>({ok:true,contentType:'video/mp4',body:pipe}),reportError:e=>errors.push(String(e)),
 videoDecoder:{probe:async()=>({duration:30,video:{width:20,height:12},audio:{sampleRate:1000,channels:1}}),
 decode:async()=>({width:20,height:12,fps:10,seek(){},nextFrame(w,h){return new Uint8Array(w*h*4);},close(){}}),
 decodeAudio:async()=>{if(!available)throw Error('not yet decodable');openedAudio++;return{sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}};}},
 audio:{open(o,listener){outputs.push({listener});return outputs.length;},write(){},close(){return 0;},finish(){}}});
const ev=s=>renderer.evaluate(s),wait=async f=>{for(let i=0;i<250&&!f();i++)await Bun.sleep(10);assert(f(),'late-audio timeout '+JSON.stringify({openedAudio,messages:messages.map(m=>m.type),errors}));};
try{
 renderer.resize(240,180,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://prepared.test/',contentType:'text/html',source:'<video id=v width=100 height=60 src="clip.mp4"></video>'});
 await renderer.whenLoaded();await ev('window.v=document.getElementById("v");v.play()');
 await wait(()=>messages.some(m=>m.type==='video-open'));
 const id=messages.find(m=>m.type==='video-open').id;assert.equal(outputs.length,0);
 available=true;pipe.append(new Uint8Array(1024));await wait(()=>openedAudio>0);
 await ev('v.currentTime');await Bun.sleep(10);assert.equal(outputs.length,0,'audio which becomes decodable later also waits for video preparation');
 renderer.videoReport({id,prepared:true});await wait(()=>outputs.length===1);
 outputs[0].listener({event:'ready'});assert.equal(outputs.length,1);
 assert(messages.some(m=>m.type==='video-bind'&&m.id===id&&m.audioId===1));
 await ev('v.pause()');assert.deepEqual(errors,[]);process.stdout.write(JSON.stringify({pass:true,mode:'late-audio'})+'\n');
}finally{renderer.dispose();pipe.finish();}

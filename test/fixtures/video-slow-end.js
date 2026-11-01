import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
let decoded=0;const errors=[];
const renderer=await createPageRenderer({
 fetchResource:async()=>({ok:true,contentType:'video/mp4',body:new Uint8Array([1])}),
 reportError:e=>errors.push(String(e)),
 videoDecoder:{
  probe:async()=>({duration:.12,video:{width:2,height:2,fpsNum:100,fpsDen:1}}),
  decode:async()=>{let index=0;return {width:2,height:2,fps:100,
   seek(){index=0},close(){},nextFrame(width=2,height=2){
    if(index===12)return null;
    const end=performance.now()+25;while(performance.now()<end){}
    index++;decoded=index;const pixels=new Uint8Array(width*height*4);
    for(let i=0;i<pixels.length;i+=4){pixels[i]=index*20;pixels[i+3]=255}return pixels;
   }}},
 },
});
try{
 renderer.setScripting('host');
 await renderer.loadDocument({url:'https://slow-video.test/',contentType:'text/html',source:'<video id="v" src="slow.mp4" controls></video>'});
 await renderer.evaluate(`globalThis.v=document.querySelector("video");
 globalThis.positions=[];v.addEventListener('timeupdate',()=>{
  if(v.ended)return;
  const c=document.createElement('canvas');c.width=c.height=2;
  const x=c.getContext('2d');x.drawImage(v,0,0,2,2);
  positions.push([v.currentTime,x.getImageData(0,0,1,1).data[0]]);
 });v.play()`);
 for(let i=0;i<100&&!await renderer.evaluate('v.ended');i++)await Bun.sleep(10);
 assert.equal(await renderer.evaluate('v.ended'),true);
 assert.equal(decoded,12,'ended must wait for all frames of a slow silent decoder');
 const last=await renderer.evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=2;const x=c.getContext('2d');x.drawImage(v,0,0,2,2);return x.getImageData(0,0,1,1).data[0]})()`);
 assert.equal(last,240,'the actual final frame must be retained at ended');
 const positions=await renderer.evaluate('positions');
 assert.ok(positions.length>0,'playback must report progress');
 for(const [time,red] of positions)assert.ok(time<=(red/20-1)/100+1e-6,
  `progress ${time} must not lead displayed frame ${red}`);
 assert.deepEqual(errors,[]);
 process.stdout.write('slow video end integration passed\n');
}finally{renderer.dispose()}

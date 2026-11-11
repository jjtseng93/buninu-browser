import {strict as assert} from 'node:assert';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
import {animatedGif} from './animated-gif.js';
const sleep=Bun.sleep,now=Date.now,write=process.stdout.write.bind(process.stdout);
const {CanvasKit:k}=await loadGraphics();
const decode=k.MakeAnimatedImageFromEncoded;
let decoders=0,pixels=0,frames=0;
k.MakeAnimatedImageFromEncoded=bytes=>{
 const a=decode(bytes);if(!a)return a;decoders++;
 const drop=a.delete.bind(a),make=a.makeImageAtCurrentFrame.bind(a);
 a.delete=()=>{decoders--;drop()};
 a.makeImageAtCurrentFrame=()=>{
  const im=make();if(!im)return im;pixels++;
  const remove=im.delete.bind(im);im.delete=()=>{pixels--;remove()};return im;
 };
 return a;
};
const renderer=await createPageRenderer({onFrame:()=>frames++,fetchResource:async url=>({
 ok:true,status:200,url,body:animatedGif()
})});
async function until(fn){const end=now()+5000;while(!await fn()){assert.ok(now()<end,'timed out '+JSON.stringify({decoders,pixels,frames,condition:String(fn)}));await sleep(20)}}
try{
 renderer.resize(80,80,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://gif.test/',contentType:'text/html',source:
   '<body style="margin:0"><img id="im" width="20" height="20"><div id="bg" style="width:20px;height:20px"></div></body>'});
 await renderer.whenLoaded();
 for(let n=0;n<3;n++){
  await renderer.evaluate('document.getElementById("im").src="/a.gif";document.getElementById("bg").style.backgroundImage="url(/b.gif)"');
  await until(()=>decoders===2);
  const start=frames;await until(()=>frames>start+2);
  assert.equal(pixels,2,'retain only current frame for each decoder');
  await renderer.evaluate('document.getElementById("im").removeAttribute("src");document.getElementById("bg").style.backgroundImage="none"');
  await until(()=>decoders===0);assert.equal(pixels,0);
 }
 // Host test mode shares this process's globals; navigation itself needs no JS.
 renderer.setScripting('off');
 await renderer.loadDocument({url:'https://gif.test/',contentType:'text/html',source:'<img width="20" height="20" src="/a.gif">'});
 await renderer.whenLoaded();await until(()=>decoders===1);
 const before=frames;await until(()=>frames>before);
}finally{renderer.dispose()}
assert.equal(decoders,0);assert.equal(pixels,0);
const last=frames;await sleep(400);assert.equal(frames,last,'disposed timers must not repaint');
write('animated image lifetime passed\n');

// Isolated because host scripting installs browser globals in this process.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const sleep=Bun.sleep, report=text=>process.stdout.write(text+'\n');
const errors=[],frames=[],messages=[];
let seeked=0;
const renderer=await createPageRenderer({
  renderMinInterval:80,
  onFrame:frame=>frames.push(frame.tile),onVideo:message=>messages.push(message),
  fetchResource:async url=>({ok:true,url,body:new Uint8Array([1]),contentType:'video/mp4'}),
  reportError:error=>errors.push(String(error)),
  videoDecoder:{
    probe:async()=>({duration:10,video:{width:20,height:12}}),
    decode:async()=>({width:20,height:12,fps:100,
      nextFrame(w,h){const data=new Uint8Array(w*h*4);for(let i=0;i<data.length;i+=4)data.set([60+seeked,90,120,255],i);return data;},
      seek(ms){seeked=Math.floor(ms/100);},close(){}}),
  },
});
function pixel(tile,x,y){const at=(Math.round((y-tile.y)*tile.scale)*tile.pixelWidth+Math.round((x-tile.x)*tile.scale))*4;return [...tile.pixels.subarray(at,at+4)];}
try{
  renderer.resize(240,180,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://media.test/',contentType:'text/html',source:'<style>body{margin:0}video{display:block;width:200px;height:120px}#marker{width:20px;height:20px;background:red}</style><video id=v src="clip.mp4"></video><div id=marker></div><video id=native src="clip.mp4" controls style="display:none"></video>'});
  await renderer.whenLoaded();
  await renderer.evaluate('document.getElementById("v").play()');
  await sleep(160);
  assert.ok(messages.some(message=>message.type==='video-open'),'first metadata/play starts independent presentation');
  assert.ok(frames.at(-1).videoLayer);
  frames.length=0;
  await renderer.evaluate('setTimeout(()=>{document.getElementById("marker").style.background="blue"},1)');
  await sleep(180);
  assert.ok(frames.length>0,'scheduled UI frame is still published');
  assert.ok(frames.every(tile=>pixel(tile,5,125).join(',')==='0,0,255,255'),'media ticks must not publish stale red UI before the scheduled rebuild');
  await renderer.evaluate('document.getElementById("v").pause()');
  assert.ok(messages.some(message=>message.type==='video-stop'),'pause stops independent presentation');
  assert.equal(frames.at(-1).videoLayer,null,'paused frame returns to normal raster');
  await renderer.evaluate('document.getElementById("v").currentTime=3');
  await sleep(80);
  assert.ok(seeked>0,'paused seek positions the decoder');
  assert.ok(pixel(frames.at(-1),5,5)[0]>60,'paused seek publishes its decoded picture');
  await renderer.evaluate('document.getElementById("v").style.display="none";document.getElementById("native").style.display="block"');
  await renderer.evaluate('document.getElementById("native").play()');
  const before=frames.length;
  await sleep(140);
  assert.ok(frames.length>before,'native controls/local playback continue repainting');
  assert.equal(frames.at(-1).videoLayer,null,'native controls retain the normal rendering path');
  await renderer.evaluate('document.getElementById("native").pause()');
  assert.deepEqual(errors,[]);report('media repaint integration passed');
}finally{renderer.dispose();}

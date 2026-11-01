import {strict as assert} from 'node:assert';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
const {CanvasKit:kit}=await loadGraphics();
const traces=[];
const r=await createPageRenderer({onFrame:()=>{},trace:s=>traces.push(s)});
async function pixels(){
 const image=kit.MakeImageFromEncoded(Buffer.from(await r.screenshot(),'base64'));
 try{return image.readPixels(0,0,{width:image.width(),height:image.height(),colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})}
 finally{image.delete()}
}
try{
 r.resize(64,48,1);r.setScripting('host');
 await r.loadDocument({url:'https://canvas.test/',contentType:'text/html',source:`<!doctype html><style>body{margin:0;background:#196ab3}canvas{display:block}</style><canvas id=c width=64 height=48></canvas><script>window.c=document.getElementById('c');window.ctx=c.getContext('2d');</script>`});
 await r.whenLoaded();
 for(const command of [
  "ctx.clearRect(0,0,64,48)",
  "ctx.fillStyle='red';ctx.fillRect(0,0,64,48)",
  "{let data=ctx.createImageData(64,48);for(let i=0;i<data.data.length;i+=4){data.data[i]=(i*37)%256;data.data[i+1]=(i*17+71)%256;data.data[i+2]=(i*53+119)%256;data.data[i+3]=(i/4)%256;}ctx.putImageData(data,0,0);}",
  "ctx.clearRect(0,0,64,48);ctx.fillStyle='rgba(230,80,40,.5)';ctx.fillRect(3,4,40,30);ctx.fillStyle='rgba(10,240,150,.2)';ctx.fillRect(20,10,30,35)",
 ]){
  traces.length=0;await r.evaluate("c.style.transform='none';"+command);
  const direct=await pixels();
  assert.ok(traces.some(s=>s.includes('direct canvas composition')),'exercise direct composition');
  traces.length=0;await r.evaluate("c.style.transform='translate(0px,0px)'");
  assert.deepEqual(await pixels(),direct,'direct copy/blend must match Skia pixel for pixel');
  assert.ok(!traces.some(s=>s.includes('direct canvas composition')),'transform keeps native fallback');
 }
 // A high-DPI canvas can still be passed through when bitmap pixels match
 // the tile's physical dimensions, with no CSS resampling.
 r.resize(64,48,2);
 traces.length=0;
 await r.evaluate("c.width=128;c.height=96;c.style.cssText='width:64px;height:48px';ctx.fillStyle='rgba(200,30,70,.6)';ctx.fillRect(0,0,128,96)");
 const highDpi=await pixels();assert.ok(traces.some(s=>s.includes('direct canvas composition')));
 traces.length=0;await r.evaluate("c.style.transform='translate(0px,0px)'");
 assert.deepEqual(await pixels(),highDpi,'high-DPI direct pixels match Skia');
 r.resize(64,48,1);await r.evaluate("c.width=64;c.height=48;c.style.cssText=''");
 // Returning from direct pixels to Skia must repaint the retained surface in
 // full; it cannot apply damage to the surface from before the bypass.
 for(const css of ['opacity:.5','border-radius:8px','width:32px']){
  await r.evaluate("c.style.cssText='';ctx.fillStyle='blue';ctx.fillRect(0,0,64,48)");await pixels();
  traces.length=0;await r.evaluate(`c.style.cssText=${JSON.stringify(css)}`);
  const fallback=await pixels();
  assert.ok(!traces.some(s=>s.includes('direct canvas composition')),css);
  r.resize(65,48,1);r.resize(64,48,1);
  assert.deepEqual(await pixels(),fallback,'fallback after direct output matches full repaint');
 }
 await r.evaluate("c.style.cssText='';document.body.insertAdjacentHTML('beforeend','<span style=\"position:absolute;left:4px;top:4px;background:yellow\">overlay</span>')");
 traces.length=0;await pixels();assert.ok(!traces.some(s=>s.includes('direct canvas composition')),'foreground content cannot be omitted');
 console.log('direct canvas composition passed');
}finally{r.dispose()}

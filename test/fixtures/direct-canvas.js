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
 // A single Canvas need not fill the page: keep surrounding background and
 // the native nearest-sampling pixel-center rule for fractional placement.
 r.resize(96,80,1);
 for(const [x,y] of [[0,0],[8,5],[8.12,5.24],[8.49,5.49],[8.51,5.51],[-9.2,-4.7],[60.2,50.8]]){
  await r.evaluate(`c.style.cssText='position:absolute;left:${x}px;top:${y}px';ctx.clearRect(0,0,64,48);ctx.fillStyle='rgba(240,20,80,.5)';ctx.fillRect(1,1,40,30)`);
  traces.length=0;const placed=await pixels();
  // evaluate may have already published the direct frame.
  await r.evaluate("ctx.fillRect(1,1,1,1)");const updated=await pixels();
  assert.ok(traces.some(s=>s.includes('direct canvas composition')),'inset/partially clipped canvas uses direct composition');
  await r.evaluate("c.style.transform='translate(0px,0px)'");
  assert.deepEqual(await pixels(),updated,`placed canvas at ${x},${y} matches Skia`);
 }
 r.resize(64,48,1);await r.evaluate("c.style.cssText=''");
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
 for(const css of ['opacity:.5','border-radius:8px']){
  await r.evaluate("c.style.cssText='';ctx.fillStyle='blue';ctx.fillRect(0,0,64,48)");await pixels();
  traces.length=0;await r.evaluate(`c.style.cssText=${JSON.stringify(css)}`);
  const fallback=await pixels();
  assert.ok(!traces.some(s=>s.includes('direct canvas composition')),css);
  r.resize(65,48,1);r.resize(64,48,1);
  assert.deepEqual(await pixels(),fallback,'fallback after direct output matches full repaint');
 }
 await r.evaluate("c.style.cssText='';document.body.insertAdjacentHTML('beforeend','<span style=\"position:absolute;left:4px;top:4px;background:yellow\">overlay</span>')");
 traces.length=0;await r.evaluate("ctx.fillStyle='red';ctx.fillRect(1,1,2,2)");
 const overlay=await pixels();assert.ok(traces.some(s=>s.includes('direct canvas composition')),'foreground DOM is a cached layer');
 await r.evaluate("c.style.transform='translate(0px,0px)'");assert.deepEqual(await pixels(),overlay,'foreground layer preserves paint order');
 await r.evaluate("c.style.cssText='width:32px'");traces.length=0;
 await r.evaluate("ctx.clearRect(0,0,64,48);ctx.fillStyle='blue';ctx.fillRect(0,0,32,48)");
 const scaled=await pixels();assert.ok(traces.some(s=>s.includes('direct canvas composition')),'scaled Canvas uses Land sampler');
 await r.evaluate("c.style.transform='translate(0px,0px)'");assert.deepEqual(await pixels(),scaled,'Land scaling matches Skia');
 // Cached DOM layers stay out of the frame loop, but DOM mutations invalidate
 // them. Multiple translucent canvases retain their original paint order.
 await r.evaluate("c.style.cssText='';document.body.insertAdjacentHTML('beforeend','<canvas id=second width=20 height=10 style=\"position:absolute;left:8px;top:12px\"></canvas>');var second=document.getElementById('second');var other=second.getContext('2d');other.fillStyle='rgba(0,240,50,.5)';other.fillRect(0,0,20,10)");
 await pixels();traces.length=0;
 await r.evaluate("ctx.fillStyle='blue';ctx.fillRect(0,0,64,48)");const multiple=await pixels();
 assert.ok(traces.some(s=>s.includes('direct canvas composition')));
 assert.ok(!traces.some(s=>s.includes('DOM layers rebuilt')),'unchanged DOM layers are reused across Canvas updates');
 await r.evaluate("c.style.transform='translate(0px,0px)'");assert.deepEqual(await pixels(),multiple,'multiple translucent layers match Skia');
 await r.evaluate("c.style.transform='none';document.querySelector('span').textContent='changed'");
 const changedDom=await pixels();
 await r.evaluate("c.style.transform='translate(0px,0px)'");assert.deepEqual(await pixels(),changedDom,'DOM cache invalidates when overlay text changes');
 console.log('direct canvas composition passed');
}finally{r.dispose()}

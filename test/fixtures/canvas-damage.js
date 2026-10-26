import {strict as assert} from 'node:assert';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
const {CanvasKit:kit}=await loadGraphics();
const traces=[];
const r=await createPageRenderer({onFrame:()=>{},trace:s=>traces.push(s)});
async function pixels(){
 const image=kit.MakeImageFromEncoded(Buffer.from(await r.screenshot(),'base64'));
 try{return image.readPixels(0,0,{width:image.width(),height:image.height(),colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})}finally{image.delete()}
}
try{
 r.resize(400,300,1);r.setScripting('host');
 await r.loadDocument({url:'https://damage.test/',contentType:'text/html',source:`
 <!doctype html><html><head><style>body{margin:0;background:#abc}.clip{position:absolute;left:30px;top:20px;width:90px;height:80px;overflow:hidden;border-radius:15px;background:yellow}canvas{width:120px;height:100px;opacity:.6}.over{position:absolute;left:50px;top:40px;width:30px;height:30px;background:green}</style></head><body>
 <div class=clip><canvas width=120 height=100></canvas></div><div class=over></div><p style="position:absolute;top:160px">Preserve text outside canvas</p>
 <script>globalThis.ctx=document.querySelector('canvas').getContext('2d');</script></body></html>`});
 await r.whenLoaded();
 await r.evaluate("ctx.fillRect(0,0,1,1)");
 await pixels();await Bun.sleep(100);
 for(const command of ["ctx.fillStyle='red';ctx.fillRect(0,0,120,100)","ctx.clearRect(0,0,120,100);ctx.fillStyle='blue';ctx.fillRect(15,15,20,20)","ctx.clearRect(0,0,120,100)"]){
  traces.length=0;
  await r.evaluate(command);
  const partial=await pixels();
  assert.ok(traces.some(s=>s.includes('canvas damage')),'exercise the partial paint path');
  r.resize(401,300,1);r.resize(400,300,1);
  assert.deepEqual(await pixels(),partial,'partial pixels must match a full repaint, including transparency, clipping and occlusion');
 }
 // Geometry/transform changes must fall back, then remain pixel-correct.
 traces.length=0;
 await r.evaluate("document.querySelector('.clip').style.transform='scale(1.2)';ctx.fillRect(0,0,80,80)");
 const transformed=await pixels();
 assert.ok(!traces.some(s=>s.includes('canvas damage')));
 r.resize(401,300,1);r.resize(400,300,1);
 assert.deepEqual(await pixels(),transformed);
 traces.length=0;
 await r.evaluate("ctx.clearRect(0,0,120,100)");
 const cleared=await pixels();
 assert.ok(!traces.some(s=>s.includes('canvas damage')),'transformed canvas stays on full paint');
 r.resize(401,300,1);r.resize(400,300,1);
 assert.deepEqual(await pixels(),cleared);
}finally{r.dispose()}

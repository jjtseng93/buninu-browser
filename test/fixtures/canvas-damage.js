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
  assert.ok(traces.some(s=>s.includes('paint damage')),'exercise the partial paint path');
  r.resize(401,300,1);r.resize(400,300,1);
  assert.deepEqual(await pixels(),partial,'partial pixels must match a full repaint, including transparency, clipping and occlusion');
 }
 // A changing coordinate/status label must not disable local canvas damage.
 await r.evaluate("document.querySelector('p').id='status'");await pixels();
 for(const text of ['Dragging 123, 456','Short','拖曳 8, 9','Italic fj']){
  traces.length=0;
  await r.evaluate(`document.getElementById('status').textContent=${JSON.stringify(text)};ctx.fillStyle='red';ctx.fillRect(10,10,20,20)`);
  const partial=await pixels();
  assert.ok(traces.some(s=>s.includes('paint damage')),'status text and canvas share partial repaint');
  r.resize(401,300,1);r.resize(400,300,1);
  assert.deepEqual(await pixels(),partial,'status replacement clears old glyphs and matches full repaint');
 }
 // A font change repaints only the text it moves, and still matches a full repaint.
 traces.length=0;
 await r.evaluate("document.getElementById('status').style.fontSize='30px';ctx.fillRect(0,0,5,5)");
 const restyled=await pixels();
 assert.ok(traces.some(s=>s.includes('paint damage')),'a font change repaints only the text it moves');
 r.resize(401,300,1);r.resize(400,300,1);assert.deepEqual(await pixels(),restyled);
 // Italic overhang and fractional raster scaling must preserve the same pixels.
 await r.evaluate("document.getElementById('status').style.fontStyle='italic'");
 r.resize(400,300,1.5);await pixels();traces.length=0;
 await r.evaluate("document.getElementById('status').textContent='fj';ctx.clearRect(0,0,120,100)");
 const italic=await pixels();assert.ok(traces.some(s=>s.includes('paint damage')));
 r.resize(401,300,1.5);r.resize(400,300,1.5);assert.deepEqual(await pixels(),italic);
 r.resize(400,300,1);
 // A transform repaints its transformed bounds, before and after, pixel for pixel.
 traces.length=0;
 await r.evaluate("document.querySelector('.clip').style.transform='scale(1.2)';ctx.fillRect(0,0,80,80)");
 const transformed=await pixels();
 assert.ok(traces.some(s=>s.includes('paint damage')),'a transform repaints only where the box was and is');
 r.resize(401,300,1);r.resize(400,300,1);
 assert.deepEqual(await pixels(),transformed);
 traces.length=0;
 await r.evaluate("ctx.clearRect(0,0,120,100)");
 const cleared=await pixels();
 assert.ok(traces.some(s=>s.includes('paint damage')),'a transformed canvas repaints only its transformed bounds');
 r.resize(401,300,1);r.resize(400,300,1);
 assert.deepEqual(await pixels(),cleared);
 // Ordinary DOM changes, as a QML animation makes them: a box moves, then one
 // appears and goes away (the display list changes length).
 await r.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=mover style=\"position:absolute;left:200px;top:200px;width:20px;height:20px;background:purple\"></div>')");
 await pixels();
 for(const command of ["document.getElementById('mover').style.left='240px'","document.getElementById('mover').style.background='orange'",
   "document.body.insertAdjacentHTML('beforeend','<div id=extra style=\"position:absolute;left:300px;top:60px;width:30px;height:30px;background:teal\"></div>')",
   "document.getElementById('extra').remove()"]){
  traces.length=0;
  await r.evaluate(command);
  const partial=await pixels();
  assert.ok(traces.some(s=>s.includes('paint damage')),`${command} repaints only what changed`);
  r.resize(401,300,1);r.resize(400,300,1);
  assert.deepEqual(await pixels(),partial,`${command} matches a full repaint`);
 }
 // Fixed content follows the viewport, not the document, so it repaints the whole tile.
 await r.evaluate("document.getElementById('mover').style.position='fixed'");await pixels();
 traces.length=0;
 await r.evaluate("document.getElementById('mover').style.left='260px'");
 const fixed=await pixels();
 assert.ok(!traces.some(s=>s.includes('paint damage')),'a fixed box repaints fully');
 r.resize(401,300,1);r.resize(400,300,1);
 assert.deepEqual(await pixels(),fixed);
}finally{r.dispose()}

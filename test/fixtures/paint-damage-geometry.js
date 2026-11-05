import {strict as assert} from 'node:assert';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
const {CanvasKit:kit}=await loadGraphics(),traces=[];
const renderer=await createPageRenderer({onFrame:()=>{},trace:s=>traces.push(s)});
async function pixels(){
  const image=kit.MakeImageFromEncoded(Buffer.from(await renderer.screenshot(),'base64'));
  try{return image.readPixels(0,0,{width:image.width(),height:image.height(),colorType:kit.ColorType.RGBA_8888,
    alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})}finally{image.delete()}
}
try{
  renderer.resize(600,400,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://damage-geometry.test/',contentType:'text/html',source:'<!doctype html><body style="margin:0;background:white"></body>'});
  await renderer.whenLoaded();
  for(const scale of [.5,1,1.5,2]){
    renderer.resize(600,400,scale);
    for(const [name,html,change] of [
      ['affine rounding', '<div id=a style="position:absolute;left:100.49px;top:100.49px;width:5.49px;height:5.49px;background:red;transform-origin:0 0;transform:matrix(8,0,3,2,0,0)"></div>',"a.style.left='150.49px'"],
      ['transformed italic glyphs','<div id=a style="position:absolute;left:100px;top:100px;font:italic 10px serif;transform-origin:0 0;transform:scale(4,2)">fj</div>',"a.textContent='j'"],
      ['square multicolor border','<div style="position:absolute;left:30.4px;top:40.4px;width:80px;height:60px;border:3px solid red;border-right-color:blue;border-bottom-color:green"></div><div id=a style="position:absolute;left:29px;top:39px;width:10px;height:10px;background:#ffaa0080"></div>',"a.style.background='transparent'"],
    ]){
      await renderer.evaluate(`document.body.innerHTML=${JSON.stringify(html)}`);
      await pixels();traces.length=0;
      await renderer.evaluate(`(()=>{const a=document.getElementById('a');${change}})()`);
      const partial=await pixels();
      assert.ok(traces.some(s=>s.includes('paint damage')),`${name} DPR ${scale}: retain local repaint`);
      renderer.resize(601,400,scale);renderer.resize(600,400,scale);
      assert.deepEqual(await pixels(),partial,`${name} DPR ${scale}: partial paint matches full paint`);
    }
  }
}finally{renderer.dispose()}

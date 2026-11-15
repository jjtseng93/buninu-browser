import {test,expect} from 'bun:test';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {decodeSvgImage} from '../lib/renderer/svg-image.js';
import {RendererHost} from '../lib/renderer/host.js';
test('SVG raster snapshots contain text using bundled serif and fallback fonts',async()=>{
 const {CanvasKit:kit,genericFamilies}=await loadGraphics();
 expect(genericFamilies.get('serif')).not.toBe(genericFamilies.get('sans-serif'));
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="2" y="30" font-size="24" font-family="serif" fill="red">Hello 中文</text></svg>';
 const resource=decodeSvgImage(kit,Buffer.from(svg),'https://svg.test/text');
 try {
  const pixels=resource.image.readPixels(0,0,{width:200,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
  let ink=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])ink++;
  expect(ink).toBeGreaterThan(100);
 }finally{resource.image.delete();}
});
test('canvas drawImage and createImageBitmap preserve SVG text',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://svg.test/',contentType:'text/html',source:'<!doctype html><canvas id="c" width="120" height="40"></canvas>'});await host.call('whenLoaded');
  const result=await host.call('evaluate',`(async()=>{
   const svg='<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="2" y="30" font-size="25">Hello</text></svg>';
   const canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
   const ink=()=>{let n=0;const p=ctx.getImageData(0,0,120,40).data;for(let i=3;i<p.length;i+=4)if(p[i])n++;return n};
   const img=new Image();img.src='data:image/svg+xml,'+encodeURIComponent(svg);await img.decode();ctx.drawImage(img,0,0);const imageInk=ink();
   ctx.clearRect(0,0,120,40);const bitmap=await createImageBitmap(new Blob([svg],{type:'image/svg+xml'}));ctx.drawImage(bitmap,0,0);const bitmapInk=ink();bitmap.close();return [imageInk,bitmapInk];
  })()`);
  expect(result[0]).toBeGreaterThan(100);expect(result[1]).toBeGreaterThan(100);
 } finally {host.close();}
},60000);

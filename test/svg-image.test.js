import {beforeAll,test,expect} from 'bun:test';
import CanvasKitInit from '../usr/lib/canvaskit/canvaskit.js';
import {decodeSvgImage} from '../lib/renderer/svg-image.js';
import {createImageResourceLoader} from '../lib/renderer/image-resources.js';
let kit;
beforeAll(async()=>{kit=await CanvasKitInit({wasmBinary:await Bun.file(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).arrayBuffer()});});
function image(body,attrs='width="40" height="20"') {return decodeSvgImage(kit,Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`),'https://svg.test/image');}
function pixel(resource,x,y){return Array.from(resource.image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB}));}
test('shared loader decodes extensionless SVG MIME and preserves consumer ownership',async()=>{
 let fetched=0;const load=createImageResourceLoader(kit,async()=>{fetched++;return {ok:true,headers:[['Content-Type','image/svg+xml']],body:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>')};});
 const doc={},[a,b]=await Promise.all([load(doc,'https://svg.test/asset'),load(doc,'https://svg.test/asset')]);
 try{expect(fetched).toBe(1);expect(pixel(a,10,10)).toEqual([255,0,0,255]);a.image.delete();expect(pixel(b,10,10)).toEqual([255,0,0,255]);}finally{b.image.delete();}
});
test('linear and radial gradients, inherited stops and CSS stop colors',()=>{
 const r=image(`<style>.red {stop-color:red}</style><defs><linearGradient id="base"><stop class="red" offset="0"/><stop stop-color="blue" offset="1"/></linearGradient><linearGradient id="g" href="#base"/><radialGradient id="r"><stop stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient></defs><rect width="20" height="20" fill="url(#g)"/><circle cx="30" cy="10" r="10" fill="url(#r)"/>`);
 try{expect(pixel(r,2,10)[0]).toBeGreaterThan(200);expect(pixel(r,17,10)[2]).toBeGreaterThan(200);expect(pixel(r,30,10)[0]).toBeGreaterThan(200);expect(pixel(r,38,10)[0]).toBeLessThan(60);}finally{r.image.delete();}
});
test('local use references render and cyclic references terminate',()=>{
 const r=image('<defs><rect id="square" width="10" height="10"/><g id="cycle"><use href="#cycle"/></g></defs><use href="#square" x="20" y="5" fill="red"/><use href="#cycle"/>');
 try{expect(pixel(r,22,7)).toEqual([255,0,0,255]);expect(pixel(r,2,7)[3]).toBe(0);}finally{r.image.delete();}
});
test('clip paths and rounded stroke caps work on decoded SVG',()=>{
 const r=image('<defs><clipPath id="clip"><rect width="10" height="20"/></clipPath></defs><rect width="20" height="20" fill="red" clip-path="url(#clip)"/><path d="M25 10H35" stroke="blue" stroke-width="6" stroke-linecap="round"/>');
 try{expect(pixel(r,5,5)).toEqual([255,0,0,255]);expect(pixel(r,15,5)[3]).toBe(0);expect(pixel(r,23,10)[2]).toBe(255);}finally{r.image.delete();}
});
test('preserveAspectRatio supports none, alignment and slice',()=>{
 for(const [aspect,filled] of [['none',true],['xMidYMid meet',false],['xMinYMin slice',true]]){
  const r=image('<rect width="10" height="10" fill="red"/>',`width="40" height="20" viewBox="0 0 10 10" preserveAspectRatio="${aspect}"`);
  try{expect(pixel(r,1,1)[3]>0).toBe(filled);}finally{r.image.delete();}
 }
});
test('SVG images remain inert and enforce allocation limits',()=>{
 const r=image('<script>throw Error("must not run")</script><foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">active</div></foreignObject><rect width="10" height="10" fill="green"/>');
 try{expect(pixel(r,5,5)).toEqual([0,128,0,255]);}finally{r.image.delete();}
 expect(()=>image('', 'width="100000" height="100000"')).toThrow('pixel limit');
});
test('group opacity composites overlapping children once',()=>{
 const r=image('<g opacity=".5"><rect width="20" height="20" fill="red"/><rect x="10" width="20" height="20" fill="red"/></g>');
 try{expect(pixel(r,5,5)[3]).toBe(128);expect(pixel(r,15,5)[3]).toBe(128);}finally{r.image.delete();}
 const root=image('<rect width="40" height="20" fill="red"/>','width="40" height="20" opacity=".5"');
 try{expect(pixel(root,5,5)[3]).toBe(128);}finally{root.image.delete();}
});
test('nested SVG establishes its own viewport, translation and clipping',()=>{
 const r=image('<svg x="20" width="20" height="20" viewBox="0 0 10 10"><rect width="100%" height="100%" fill="red"/></svg>');
 try{expect(pixel(r,2,5)[3]).toBe(0);expect(pixel(r,22,5)).toEqual([255,0,0,255]);}finally{r.image.delete();}
});

test('symbol use establishes percentage geometry and group opacity',()=>{
 const r=image('<defs><symbol id="s" viewBox="0 0 10 10" opacity=".5"><rect width="50%" height="100%" fill="red"/><rect width="50%" height="100%" fill="red"/></symbol></defs><use href="#s" x="20" width="20" height="20"/>');
 try{expect(pixel(r,22,5)).toEqual([255,0,0,128]);expect(pixel(r,32,5)[3]).toBe(0);}finally{r.image.delete();}
});

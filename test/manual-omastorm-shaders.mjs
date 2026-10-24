// Offline, CPU-only compatibility probe. Reads upstream GLSL without modifying it.
import {resolve} from 'node:path';
import init from '../usr/lib/canvaskit/canvaskit.js';
import {compileFragment,makeFragmentShader} from '../lib/qml/shader/fragment.js';
import {fragmentSource} from '../lib/qml/shader/qsb.js';
const root=resolve(process.argv[2]||'../omastorm');
const kit=await init({wasmBinary:await Bun.file(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).arrayBuffer()});
for(const name of ['tile','texture-check','radar','grid']){
 const c=compileFragment(kit,fragmentSource(await Bun.file(root+'/ui/shaders/'+name+'.frag.qsb').bytes()));
 try{
  console.log(name+': CPU-compatible RuntimeEffect compiled');
  if(!['tile','texture-check'].includes(name))continue;
  const image=kit.MakeImage({width:2,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},new Uint8Array([255,0,0,255,255,0,0,255]),8);
  const child=image.makeShaderOptions(kit.TileMode.Clamp,kit.TileMode.Clamp,kit.FilterMode.Nearest,kit.MipmapMode.None);
  const shader=makeFragmentShader(c,{width:16,height:16,uniforms:{expected:[2,1],boundaries:[1,0,0,1],water:[0,0,0,0],minorRoads:[0,0,0,0],majorRoads:[0,0,0,0]},textures:{[name==='tile'?'mask':'sweep']:{shader:child,width:2,height:1}}});
  const surface=kit.MakeSurface(16,16),paint=new kit.Paint();
  try{
   paint.setShader(shader);surface.getCanvas().drawRect(kit.XYWHRect(0,0,16,16),paint);surface.flush();
   const result=surface.makeImageSnapshot();
   try{
    const pixel=Array.from(result.readPixels(0,0,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB}));
    const expected=name==='tile'?[255,0,0,255]:[0,255,0,255];
    if(JSON.stringify(pixel)!==JSON.stringify(expected))throw Error(name+' wrong pixel: '+pixel);
    console.log(name+': CPU pixel '+pixel+' verified');
   }finally{result.delete();}
  }finally{paint.delete();surface.delete();shader.delete();child.delete();image.delete();}
 }finally{c.effect.delete();}
}

import {test,expect,beforeAll} from 'bun:test';
import init from '../usr/lib/canvaskit/canvaskit.js';
import {compileFragment,makeFragmentShader,translateFragment} from '../lib/qml/shader/fragment.js';
let kit;
beforeAll(async()=>{kit=await init({wasmBinary:await Bun.file(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).arrayBuffer()});});
const header=`#version 440
layout(location=0) in vec2 qt_TexCoord0;
layout(location=0) out vec4 fragColor;
layout(std140,binding=0) uniform buf {mat4 qt_Matrix;float qt_Opacity;};`;
function pixel(compiled,options,x=0,y=0){
 const surface=kit.MakeSurface(options.width,options.height),paint=new kit.Paint();
 const shader=makeFragmentShader(compiled,options);
 try{
  paint.setShader(shader);surface.getCanvas().drawRect(kit.XYWHRect(0,0,options.width,options.height),paint);surface.flush();
  const image=surface.makeImageSnapshot();
  try{return Array.from(image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB}));}finally{image.delete();}
 }finally{paint.delete();shader.delete();surface.delete();}
}
test('Qt fragment uniform and coordinate mapping executes on CPU raster surface',()=>{
 const c=compileFragment(kit,header+'uniform int mode; void main(){fragColor=mode==2?vec4(qt_TexCoord0,0,1):vec4(0);fragColor*=qt_Opacity;}');
 try{const p=pixel(c,{width:16,height:16,uniforms:{mode:2}},8,8);expect(p).toEqual([135,135,0,255]);}finally{c.effect.delete();}
});
test('CPU child texture sampling and textureSize preserve source pixel dimensions',()=>{
 const image=kit.MakeImage({width:2,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},new Uint8Array([255,0,0,255,0,255,0,255]),8);
 const child=image.makeShaderOptions(kit.TileMode.Clamp,kit.TileMode.Clamp,kit.FilterMode.Nearest,kit.MipmapMode.None);
 const c=compileFragment(kit,header+'layout(binding=1) uniform sampler2D source;void main(){if(textureSize(source,0)!=ivec2(2,1)){fragColor=vec4(0,0,1,1);return;}fragColor=texture(source,qt_TexCoord0);}');
 try{
  const options={width:4,height:2,textures:{source:{shader:child,width:2,height:1}}};
  expect(pixel(c,options,0,0)).toEqual([255,0,0,255]);
  expect(pixel(c,options,3,0)).toEqual([0,255,0,255]);
  expect(()=>makeFragmentShader(c,{width:1,height:1})).toThrow('Missing shader texture');
 }finally{c.effect.delete();child.delete();image.delete();}
});
test('unsupported shader interfaces fail rather than rendering a success placeholder',()=>{
 expect(()=>translateFragment('#include "missing"')).toThrow('preprocessor');
 expect(()=>translateFragment(header+'void main(){discard;}')).toThrow('Unsupported');
 expect(()=>compileFragment(kit,header+'void main(){fragColor=unknown();}')).toThrow('compilation failed');
});

import {deflateSync} from 'node:zlib';
import {fragmentSource} from '../lib/qml/shader/qsb.js';
function qsb(source){
 const text=Buffer.from(source),head=Buffer.alloc(28),tail=Buffer.from([0,0,0,4,109,97,105,110]);
 [9,4,1,150,0,0,text.length].forEach((n,i)=>head.writeUInt32BE(n,i*4));
 const raw=Buffer.concat([head,text,tail]),size=Buffer.alloc(4);size.writeUInt32BE(raw.length);
 return Buffer.concat([size,deflateSync(raw)]);
}
test('QSB source records are validated and generated struct uniforms compile',()=>{
 const source='#version 150\nstruct buf {float gain;};uniform buf _12;out vec4 fragColor;void main(){fragColor=vec4(_12.gain,0,0,1);}';
 expect(fragmentSource(qsb(source))).toBe(source);
 const c=compileFragment(kit,fragmentSource(qsb(source)));
 try{expect(pixel(c,{width:1,height:1,uniforms:{gain:1}})).toEqual([255,0,0,255]);}finally{c.effect.delete();}
 expect(()=>fragmentSource(qsb(source).subarray(0,10))).toThrow();
 expect(()=>fragmentSource(qsb(source.replace('#version 150','#version 100')))).toThrow('no supported');
});

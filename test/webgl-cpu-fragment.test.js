import {beforeAll,expect,test} from 'bun:test';
import init from '../usr/lib/canvaskit/canvaskit.js';
import {compileStage,shader,floatImage,imageShader} from '../lib/renderer/webgl/pipeline.js';
import {runCPUFragment} from '../lib/renderer/webgl/cpu-fragment.js';
let kit;
beforeAll(async()=>{kit=await init({wasmBinary:await Bun.file(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).arrayBuffer()});});
function compare(source,values=new Map()){
 const stage=compileStage(kit,source,'fragment');expect(stage.cpu).not.toBeNull();
 const width=8,height=8,planes=stage.derivativeInputs?3:1,coverage=new Float32Array(width*height*planes*4);
 const varyings=stage.varyings.map(()=>new Float32Array(coverage.length));
 if(stage.derivativeInputs)values.set('_sw_tileHeight',height);
 for(let plane=0;plane<planes;plane++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=((plane*height+y)*width+x)*4;
  const px=(plane===1?x^1:x)+.5,py=(plane===2?y^1:y)+.5;
  coverage.set([1,height-py,.5,1],i);
  for(const v of varyings)v.set([px/width,py/height,.25,1],i);
 }
 const images=[coverage,...varyings].map(v=>floatImage(kit,width,height*planes,v)),children=images.map(i=>imageShader(kit,i)),surface=kit.MakeSurface(width,height),paint=new kit.Paint();let effect;
 try{effect=shader(kit,stage,values,children);paint.setShader(effect);surface.getCanvas().drawPaint(paint);surface.flush();const snapshot=surface.makeImageSnapshot();let expected;try{expected=snapshot.readPixels(0,0,{width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB});}finally{snapshot.delete();}
  const actual=runCPUFragment(stage,values,[],coverage,varyings,width,height,0,0,height);
  let difference=0;for(let i=0;i<actual.length;i++)difference=Math.max(difference,Math.abs(actual[i]-expected[i]));expect(difference).toBeLessThanOrEqual(2);return actual;
 }finally{paint.delete();effect?.delete();surface.delete();for(const c of children)c.delete();for(const i of images)i.delete();stage.effect.delete();}
}
test('numeric CPU fragment lighting and derivatives agree with CanvasKit',()=>{
 const pixels=compare('precision highp float;varying vec3 n;uniform vec3 light;void main(){vec3 N=normalize(n);float v=pow(max(dot(N,normalize(light)),0.),3.);gl_FragColor=vec4(v,abs(dFdx(n.x)),abs(dFdy(n.y)),.75);}',new Map([['light',[1,2,3]]]));
 expect([...pixels.slice(1,3)]).toEqual([24,24]);
});
test('conditional expressions and logical operators do not evaluate skipped side effects',()=>{
 const pixels=compare('precision highp float;float bump(inout float x){x+=.2;return x;}void main(){float x=0.;float a=true?bump(x):bump(x);bool b=false&&(bump(x)>0.);bool c=true||(bump(x)>0.);gl_FragColor=vec4(x,a,0.,1.);}');
 expect([...pixels.slice(0,4)]).toEqual([51,51,0,255]);
});
test('mutable shader globals are reset between pixels',()=>{
 const pixels=compare('precision highp float;float v=.25;void main(){v+=.25;gl_FragColor=vec4(v,0.,0.,1.);}');
 expect(pixels[0]).toBe(128);expect(pixels.at(-4)).toBe(128);
});
test('helper lanes evaluate the covered branch for derivatives in functions and expressions',()=>{
 const source=`precision highp float; varying vec2 uv;
 float slope(float x){return dFdx(x);}
 void main(){
   float v=0.; if(uv.x>.25)v=slope(uv.x);
   float w=uv.y>.25?dFdy(uv.y):0.;
   bool b=uv.x>.25 && dFdx(uv.x)>.25;
   gl_FragColor=vec4(v,w,b?1.:0.,1.);
 }`;
 const stage=compileStage(kit,source,'fragment',true);
 try{
  expect(stage.cpu).not.toBeNull();
  const coverage=new Float32Array(12),uv=new Float32Array(12);
  for(let lane=0;lane<3;lane++)coverage.set([1,1,.5,1],lane*4);
  uv.set([.5,.5],0);uv.set([0,.5],4);uv.set([.5,0],8);
  const result=runCPUFragment(stage,new Map(),[],coverage,[uv],1,1,1,0,1);
  expect([...result]).toEqual([.5,.5,1,1]);
 }finally{stage.effect.delete();}
});
test('ordinary branches keep the helper lane value when computing a derivative operand',()=>{
 const pixels=compare('precision highp float;varying vec2 uv;void main(){float x=0.;if(uv.x>.5)x=uv.x;gl_FragColor=vec4(dFdx(x),0.,0.,1.);}');
 expect(pixels[(4*4)]).toBe(32);
});
test('numeric vertex transforms and varyings agree with CanvasKit float output',async()=>{
 const {runVertices}=await import('../lib/renderer/webgl/pipeline.js');
 const stage=compileStage(kit,'attribute vec3 position;attribute vec3 normal;uniform mat4 model;uniform mat3 normals;varying vec3 v;void main(){v=normalize(normals*normal);gl_Position=model*vec4(position,1.);}','vertex');
 try{
  expect(stage.cpuVertex).not.toBeNull();
  const values=new Map([['model',[2,0,0,.1,0,3,0,.2,0,0,4,.3,5,6,7,1]],['normals',[1,0,0,0,2,0,0,0,3]]]);
  const attrs=new Map([['position',new Float32Array([1,2,3,-1,.5,2])],['normal',new Float32Array([1,2,3,3,2,1])]]);
  const actual=runVertices(kit,stage,values,attrs,2),reference=runVertices(kit,{...stage,cpuVertex:null},values,attrs,2);
  for(let i=0;i<actual.length;i++)expect(actual[i]).toBeCloseTo(reference[i],5);
 }finally{stage.effect.delete();}
});

test('matrix attributes, matrix conversion and varying arrays match the WASM vertex shader', async () => {
 const {runVertices}=await import('../lib/renderer/webgl/pipeline.js');
 const stage=compileStage(kit,`#version 300 es
 in mat4 instance;
 in vec3 pos;
 uniform mat4 model;
 out vec3 normals[2];
 void main(){
   normals[0]=mat3(instance)*pos;
   normals[1]=(mat4(mat3(model))*vec4(pos,1.)).xyz;
   gl_Position=model*instance*vec4(pos,1.);
 }`,'vertex');
 try{
  expect(stage.cpuVertex).not.toBeNull();
  const matrix=[1,2,3,0,4,5,6,0,7,8,9,0,2,3,4,1];
  const values=new Map([['model',matrix]]);
  const attrs=new Map([['instance',new Float32Array([...matrix,...matrix.map(x=>x*.5)])],['pos',new Float32Array([3,2,1,-1,4,2])]]);
  const actual=runVertices(kit,stage,values,attrs,2);
  const reference=runVertices(kit,{...stage,cpuVertex:null},values,attrs,2);
  for(let i=0;i<actual.length;i++)expect(actual[i]).toBeCloseTo(reference[i],4);
 }finally{stage.effect.delete();}
});

test('fixed vertex loops read indexed uniform values and match the WASM path', async () => {
 const {runVertices}=await import('../lib/renderer/webgl/pipeline.js');
 const stage=compileStage(kit,`uniform vec2 offsets[3];attribute vec2 pos;
  void main(){vec2 p=pos;for(int i=0;i<3;i++){if(i==1)continue;p+=offsets[i]*float(i+1);}gl_Position=vec4(p,0.,1.);}`,'vertex');
 try{
  expect(stage.cpuVertex).not.toBeNull();
  const values=new Map([['offsets',[1,2,3,4,-1,2]]]),attrs=new Map([['pos',new Float32Array([0,0])]]);
  expect([...runVertices(kit,stage,values,attrs,1)]).toEqual([-2,8,0,1]);
  expect(runVertices(kit,stage,values,attrs,1)).toEqual(runVertices(kit,{...stage,cpuVertex:null},values,attrs,1));
 }finally{stage.effect.delete();}
});

test('vertex texelFetch reads the selected texel using integer division for row indexing', async () => {
 const {runVertices}=await import('../lib/renderer/webgl/pipeline.js');
 const stage=compileStage(kit,`#version 300 es
 in float index;
 uniform sampler2D grid;
 void main(){int i=int(index),w=textureSize(grid,0).x;
  gl_Position=texelFetch(grid,ivec2(i%w,i/w),0);}`,'vertex');
 const pixels=new Float32Array([1,2,3,1,4,5,6,1,7,8,9,1,10,11,12,1]);
 const img=floatImage(kit,2,2,pixels);
 try{
  expect(stage.cpuVertex).not.toBeNull();
  const key=stage.uniforms.find(u=>u.name==='grid').elements[0];
  const values=new Map([['_sw_size_'+key,[2,2]]]),attrs=new Map([['index',new Float32Array([1,2,3])]]);
  const samplers=[{key,width:2,height:2,pixels,mag:9728}];
  const children=()=>[imageShader(kit,img)];
  const result=runVertices(kit,stage,values,attrs,3,children,samplers);
  expect([...result]).toEqual([...pixels.slice(4)]);
  expect(result).toEqual(runVertices(kit,{...stage,cpuVertex:null},values,attrs,3,children));
 }finally{img.delete();stage.effect.delete();}
});

test('indirect sampler arguments select the bound image and its own dimensions', async () => {
 const {runVertices}=await import('../lib/renderer/webgl/pipeline.js');
 const stage=compileStage(kit,`#version 300 es
 in float pick;
 uniform sampler2D wide;
 uniform sampler2D tall;
 vec4 readMap(sampler2D m){return texture(m,vec2(.75));}
 void main(){gl_Position=pick==0.?readMap(wide):readMap(tall);}`,'vertex');
 const images=[];
 try{
  expect(stage.cpuVertex).not.toBeNull();
  const values=new Map(),samplers=[];
  for(const [name,w,h,color] of [['wide',2,1,[1,0,0,1]],['tall',1,2,[0,1,0,1]]]){
   const key=stage.uniforms.find(u=>u.name===name).elements[0];
   const pixels=new Float32Array([0,0,0,1,...color]);
   images.push(floatImage(kit,w,h,pixels));
   values.set('_sw_size_'+key,[w,h]);
   samplers.push({key,width:w,height:h,pixels,mag:9728});
  }
  const attributes=new Map([['pick',new Float32Array([0,1])]]);
  const children=()=>images.map(image=>imageShader(kit,image));
  const actual=runVertices(kit,stage,values,attributes,2,children,samplers);
  expect([...actual]).toEqual([1,0,0,1,0,1,0,1]);
  expect(actual).toEqual(runVertices(kit,{...stage,cpuVertex:null},values,attributes,2,children));
  expect([...runVertices(kit,stage,values,attributes,2,children,samplers.slice(0,1))])
   .toEqual([1,0,0,1,0,0,0,1]);
 }finally{for(const image of images)image.delete();stage.effect.delete();}
});

test('vector equality and inequality reduce all components to a scalar', () => {
 const pixels=compare(`precision highp float;
 uniform vec3 a;
 void main(){
   vec3 b=vec3(1.,0.,3.);
   gl_FragColor=vec4(a==b?1.:0.,a!=b?1.:0.,all(equal(a,b))?1.:0.,any(equal(a,b))?1.:0.);
 }`,new Map([['a',[1,2,3]]]));
 expect([...pixels.slice(0,4)]).toEqual([0,255,0,255]);
});

test('constant-step loops break only the innermost active loop', () => {
 const pixels=compare(`precision highp float;
 uniform float cutoff;
 void main(){
   float sum=0.;
   for(int i=0;i<6;i+=2){
     for(int j=0;j<4;j++){
       if(float(j)>=cutoff)break;
       sum+=float(i);
     }
   }
   gl_FragColor=vec4(sum/12.,0.,0.,1.);
 }`,new Map([['cutoff',1]]));
 expect([...pixels.slice(0,4)]).toEqual([128,0,0,255]);
});

test('fragment input array elements receive their own interpolated values', () => {
 const stage=compileStage(kit,`#version 300 es
 precision highp float;
 in vec3 values[2];
 out vec4 color;
 void main(){color=vec4(values[1].r,values[0].g,values[1].b,1.);}`,'fragment',true);
 try{
  expect(stage.cpu).not.toBeNull();
  const coverage=Float32Array.of(1,.5,.5,1);
  const inputs=[Float32Array.of(.25,.5,.75,0),Float32Array.of(.875,.125,.375,0)];
  expect([...runCPUFragment(stage,new Map(),[],coverage,inputs,1,1,0,0,1)]).toEqual([.875,.5,.375,1]);
 }finally{stage.effect.delete();}
});

test('a numeric shader discards through a function without dropping transparent fragments', () => {
 const stage=compileStage(kit,`#version 300 es
 precision highp float;
 out vec4 color;
 void reject(){if(gl_FragCoord.x<1.)discard;}
 void main(){reject();color=vec4(.5,.25,.75,0.);}`,'fragment',true);
 try{
  expect(stage.cpu).not.toBeNull();
  const coverage=Float32Array.of(1,.5,.5,1, 1,.5,.5,1);
  const pixels=runCPUFragment(stage,new Map(),[],coverage,[],2,1,0,0,1);
  expect([...pixels]).toEqual([0,0,0,0,.5,.25,.75,0]);
  expect([coverage[3],coverage[7]]).toEqual([0,1]);
 }finally{stage.effect.delete();}
});

test('conditional derivatives preserve color and discard on both sides of the branch', () => {
 const pixels=compare(`precision highp float; varying vec2 uv;
 void main(){
   if(uv.x<.25) discard;
   float c=.5;
   if(uv.x>.5)c=dFdx(uv.x);
   if(c<.25 && uv.y<.5)discard;
   gl_FragColor=vec4(c,0.,0.,1.);
 }`);
 const at=(x,y)=>Array.from(pixels.subarray((8*y+x)*4,(8*y+x+1)*4));
 expect(at(0,0)).toEqual([0,0,0,0]);
 expect(at(2,0)).toEqual([128,0,0,255]);
 expect(at(6,0)).toEqual([0,0,0,0]);
 expect(at(6,6)).toEqual([32,0,0,255]);
});

test('scalar snapshots survive later writes, branches and swizzle swaps', () => {
 const pixels=compare(`precision highp float; varying vec2 uv;
 void main(){
   vec2 v=uv, old=v;
   v.yx=v.xy;
   if(uv.x>.5)v.x=1.-v.x;
   gl_FragColor=vec4(old.x,v.x,v.y,1.);
 }`);
 const at=(x,y)=>[...pixels.subarray((8*y+x)*4,(8*y+x+1)*4)];
 expect(at(2,1)).toEqual([80,48,80,255]);
 expect(at(6,1)).toEqual([207,207,207,255]);
});

test('live shader stages share compilation only within the same stage and cache', async () => {
 const {ShaderStageCache}=await import('../lib/renderer/webgl/stage-cache.js');
 const cache=new ShaderStageCache(), other=new ShaderStageCache();
 let compilations=0, deletions=0;
 const compile=()=>{compilations++;return {effect:{delete(){deletions++;}}};};
 const fragment=cache.get('fragment','void main(){}',compile);
 expect(cache.get('fragment','void main(){}',compile)).toBe(fragment);
 expect(cache.get('vertex','void main(){}',compile)).not.toBe(fragment);
 expect(other.get('fragment','void main(){}',compile)).not.toBe(fragment);
 expect(compilations).toBe(3);
 cache.dispose();cache.dispose();
 expect(deletions).toBe(2);
 other.dispose();
 expect(deletions).toBe(3);
});

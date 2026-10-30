import {beforeAll,expect,test} from 'bun:test';
import init from '../usr/lib/canvaskit/canvaskit.js';
import {compileStage,shader,floatImage,imageShader} from '../lib/renderer/webgl/pipeline.js';
import {runCPUFragment} from '../lib/renderer/webgl/cpu-fragment.js';
let kit;
beforeAll(async()=>{kit=await init({wasmBinary:await Bun.file(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).arrayBuffer()});});
function compare(source,values=new Map()){
 const stage=compileStage(kit,source,'fragment');expect(stage.cpu).not.toBeNull();
 const width=8,height=8,coverage=new Float32Array(width*height*4),varyings=stage.varyings.map(()=>new Float32Array(coverage.length));
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;coverage.set([1,height-y-.5,.5,1],i);for(const v of varyings)v.set([(x+.5)/width,(y+.5)/height,.25,1],i);}
 const images=[coverage,...varyings].map(v=>floatImage(kit,width,height,v)),children=images.map(i=>imageShader(kit,i)),surface=kit.MakeSurface(width,height),paint=new kit.Paint();let effect;
 try{effect=shader(kit,stage,values,children);paint.setShader(effect);surface.getCanvas().drawPaint(paint);surface.flush();const snapshot=surface.makeImageSnapshot();let expected;try{expected=snapshot.readPixels(0,0,{width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB});}finally{snapshot.delete();}
  const actual=runCPUFragment(stage,values,[],coverage,varyings,width,height,0,0,height);
  let difference=0;for(let i=0;i<actual.length;i++)difference=Math.max(difference,Math.abs(actual[i]-expected[i]));expect(difference).toBeLessThanOrEqual(2);return actual;
 }finally{paint.delete();effect?.delete();surface.delete();for(const c of children)c.delete();for(const i of images)i.delete();stage.effect.delete();}
}
test('numeric CPU fragment lighting and derivatives agree with CanvasKit',()=>{
 compare('precision highp float;varying vec3 n;uniform vec3 light;void main(){vec3 N=normalize(n);float v=pow(max(dot(N,normalize(light)),0.),3.);gl_FragColor=vec4(v,abs(dFdx(n.x)),abs(dFdy(n.y)),.75);}',new Map([['light',[1,2,3]]]));
});
test('conditional expressions and logical operators do not evaluate skipped side effects',()=>{
 const pixels=compare('precision highp float;float bump(inout float x){x+=.2;return x;}void main(){float x=0.;float a=true?bump(x):bump(x);bool b=false&&(bump(x)>0.);bool c=true||(bump(x)>0.);gl_FragColor=vec4(x,a,0.,1.);}');
 expect([...pixels.slice(0,4)]).toEqual([51,51,0,255]);
});
test('mutable shader globals are reset between pixels',()=>{
 const pixels=compare('precision highp float;float v=.25;void main(){v+=.25;gl_FragColor=vec4(v,0.,0.,1.);}');
 expect(pixels[0]).toBe(128);expect(pixels.at(-4)).toBe(128);
});
test('control-flow derivatives retain the CanvasKit fallback',()=>{
 for(const body of ['if(gl_FragCoord.x>3.)gl_FragColor=vec4(dFdx(gl_FragCoord.x));else gl_FragColor=vec4(1.);']){
  const stage=compileStage(kit,'precision highp float;void main(){'+body+'}','fragment');expect(stage.cpu).toBeNull();stage.effect.delete();
 }
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

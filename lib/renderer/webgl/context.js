import {orderedCPUFragment,createFragmentBatch} from './cpu-fragment.js';
import {writeFragment,blendEnums} from './color-buffer.js';
import {framebufferState,fbEnums} from './framebuffers.js';
import {vertexArrayState,vertexInput,triangles,elementRange,matrixInput} from './vertex-input.js';
import {DrawCache} from './draw-cache.js';
import {textureState} from './textures.js';
import {clipTriangles} from './clip.js';
import {components,glType} from './shaders.js';
import {compileStage,runVertices,shader,floatImage,imageShader} from './pipeline.js';
import { engineGlobal } from "../engine-globals.js";
const GL={DEPTH_BUFFER_BIT:256,STENCIL_BUFFER_BIT:1024,COLOR_BUFFER_BIT:16384,POINTS:0,LINES:1,LINE_LOOP:2,LINE_STRIP:3,TRIANGLES:4,TRIANGLE_STRIP:5,TRIANGLE_FAN:6,ZERO:0,ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,FUNC_ADD:32774,NEVER:512,LESS:513,EQUAL:514,LEQUAL:515,GREATER:516,NOTEQUAL:517,GEQUAL:518,ALWAYS:519,FRONT:1028,BACK:1029,FRONT_AND_BACK:1032,CW:2304,CCW:2305,CULL_FACE:2884,BLEND:3042,DEPTH_TEST:2929,SCISSOR_TEST:3089,STENCIL_TEST:2960,POLYGON_OFFSET_FILL:32823,BYTE:5120,UNSIGNED_BYTE:5121,SHORT:5122,UNSIGNED_SHORT:5123,INT:5124,UNSIGNED_INT:5125,FLOAT:5126,ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,DYNAMIC_DRAW:35048,STREAM_DRAW:35040,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,LINK_STATUS:35714,VALIDATE_STATUS:35715,ACTIVE_UNIFORMS:35718,ACTIVE_ATTRIBUTES:35721,HIGH_FLOAT:36338,MEDIUM_FLOAT:36337,LOW_FLOAT:36336,HIGH_INT:36341,MEDIUM_INT:36340,LOW_INT:36339,FLOAT_VEC2:35664,FLOAT_VEC3:35665,FLOAT_VEC4:35666,FLOAT_MAT3:35675,FLOAT_MAT4:35676,SAMPLER_2D:35678,TEXTURE_2D:3553,TEXTURE_CUBE_MAP:34067,TEXTURE_CUBE_MAP_POSITIVE_X:34069,TEXTURE0:33984,RGBA:6408,RGB:6407,ALPHA:6406,NEAREST:9728,LINEAR:9729,NEAREST_MIPMAP_NEAREST:9984,LINEAR_MIPMAP_NEAREST:9985,NEAREST_MIPMAP_LINEAR:9986,LINEAR_MIPMAP_LINEAR:9987,CLAMP_TO_EDGE:33071,REPEAT:10497,MIRRORED_REPEAT:33648,TEXTURE_MAG_FILTER:10240,TEXTURE_MIN_FILTER:10241,TEXTURE_WRAP_S:10242,TEXTURE_WRAP_T:10243,UNPACK_FLIP_Y_WEBGL:37440,UNPACK_PREMULTIPLY_ALPHA_WEBGL:37441,UNPACK_ALIGNMENT:3317,PACK_ALIGNMENT:3333,FRAMEBUFFER:36160,RENDERBUFFER:36161,FRAMEBUFFER_COMPLETE:36053,MAX_TEXTURE_SIZE:3379,MAX_CUBE_MAP_TEXTURE_SIZE:34076,MAX_TEXTURE_IMAGE_UNITS:34930,MAX_VERTEX_TEXTURE_IMAGE_UNITS:35660,MAX_COMBINED_TEXTURE_IMAGE_UNITS:35661,MAX_VERTEX_ATTRIBS:34921,MAX_VERTEX_UNIFORM_VECTORS:36347,MAX_FRAGMENT_UNIFORM_VECTORS:36349,MAX_VARYING_VECTORS:36348,MAX_VIEWPORT_DIMS:3386,VERSION:7938,SHADING_LANGUAGE_VERSION:35724,VENDOR:7936,RENDERER:7937,VIEWPORT:2978,SCISSOR_BOX:3088,NO_ERROR:0,INVALID_ENUM:1280,INVALID_VALUE:1281,INVALID_OPERATION:1282,OUT_OF_MEMORY:1285};
export function createSoftwareGL(kit,state,changed,options={},webgl2=false){
 options ??= {};
 let resolveImage=options.resolveImage;
 let publicCanvas=options.canvas ? new WeakRef(options.canvas) : null;
 const hasDefaultDepth=options.depth===undefined||Boolean(options.depth);
 const defaultDepth=()=>hasDefaultDepth?new Float32Array(state.width*state.height).fill(1):null;
 let error=0,program=null,array=null,enabled=new Set(),depth=defaultDepth(),vp=[0,0,state.width,state.height],clear=[0,0,0,0],clearZ=1,writeDepth=true,depthFunc=GL.LESS,front=GL.CCW,cull=GL.BACK;
 // Like a graphics command buffer, defer raster work until the bitmap is read.
 // A full color+depth clear makes earlier unobserved draws redundant. Vertex
 // outputs and uniforms are captured at draw time, so later mutations are safe.
 let pending=[],pendingBytes=0,colorPixels=new Uint8Array(state.width*state.height*4),pixelsDirty=false,depthDirty=false;
 let blend={mask:[true,true,true,true],factors:[1,0,1,0],equations:[GL.FUNC_ADD,GL.FUNC_ADD],color:[0,0,0,0]};
 const defaultBuffer={color:colorPixels,depth};
 let targetWidth=state.width,targetHeight=state.height,scissor=[0,0,state.width,state.height];
 function storageFor(handle,slot=0,reading=false){
  if(!handle)return {...defaultBuffer,width:state.width,height:state.height};
  const target=fb.describe(handle,slot,reading);
  if(!target)return null;
  const size=target.width*target.height;
  const color=target.color,depthImage=target.depth;
  if(color&&!color.renderPixels){
   const floating=color.pixels instanceof Float32Array||color.type!==undefined&&color.type!==5121||color.format===0x8814||color.format===0x881a;
   color.renderPixels=floating?new Float32Array(size*4):new Uint8Array(size*4);
   if(color.pixels){const row=target.width*4;for(let y=0;y<target.height;y++)color.renderPixels.set(color.pixels.subarray(y*row,(y+1)*row),(target.height-1-y)*row);}
  }
  if(depthImage&&!depthImage.depthPixels){
   const plane=new Float32Array(size);
   const data=depthImage.pixels;
   if(data){
    const scale=data instanceof Float32Array?1:1/255;
    for(let y=0;y<target.height;y++)for(let x=0;x<target.width;x++)
     plane[(target.height-1-y)*target.width+x]=data[(y*target.width+x)*4]*scale;
   }else plane.fill(1);
   depthImage.depthPixels=plane;
  }
  return {color:color?.renderPixels,depth:depthImage?.depthPixels,width:target.width,height:target.height};
 }
 function bindStorage(slot=0){
  const storage=storageFor(fb.draw(),slot);
  if(!storage)return false;
  ({color:colorPixels,depth,width:targetWidth,height:targetHeight}=storage);
  return true;
 }
 function invalidate(){if(!fb.draw())changed(state);}
 function flushPending(){
  const jobs=pending;pending=[];pendingBytes=0;
  for(const job of jobs)job();
  texture.releaseRetired();
  if(!pixelsDirty&&!depthDirty)return;
  if(fb.draw()){
   for(let slot=0;slot<fb.slots();slot++){
    const target=fb.describe(fb.draw(),slot);
    if(pixelsDirty&&target?.color?.renderPixels)texture.markRendered(target.ref,target.color);
    if(slot===0&&depthDirty&&target?.depth?.depthPixels)texture.markRendered(target.depthRef,target.depth,true);
   }
  }else if(pixelsDirty)state.raster.getCanvas().writePixels(colorPixels,state.width,state.height,0,0,kit.AlphaType.Unpremul,kit.ColorType.RGBA_8888,kit.ColorSpace.SRGB);
  pixelsDirty=false;depthDirty=false;
 }
 const buffers=new WeakMap(),shaders=new WeakMap(),programs=new WeakMap(),locations=new WeakMap(),resources=new Set();
 const object=(tag,map,data)=>{const obj=Object.create(null);Object.defineProperty(obj,Symbol.toStringTag,{value:tag});map.set(obj,data);return obj;};
 const fail=code=>{error ||= code;};
 const vao=vertexArrayState(fail);
 const constants=new Map();
 const getP=()=>programs.get(program);
 const fragments=new DrawCache();
 const texture=textureState(kit,()=>resolveImage,flushPending,fail,webgl2);
 const fb=framebufferState(texture,flushPending,fail);
 const methods={
  getContextAttributes:()=>({alpha:true,depth:hasDefaultDepth,stencil:false,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true}),isContextLost:()=>!state.surface,
  getError:()=>{const e=error;error=0;return e;},getSupportedExtensions:()=>['OES_element_index_uint'],getExtension:name=>name==='OES_element_index_uint'?Object.create(null):null,
  getShaderPrecisionFormat:()=>({rangeMin:127,rangeMax:127,precision:23}),
  getParameter:p=>p===0x8ca6?fb.draw():p===0x8caa?fb.read():p===0x8ca7?fb.render():webgl2&&p===0x85B5?vao.binding():p===0x8895?vao.current().elements:({[GL.VERSION]:webgl2?'WebGL 2.0 (Buninu CPU)':'WebGL 1.0 (Buninu CPU)',[GL.SHADING_LANGUAGE_VERSION]:webgl2?'WebGL GLSL ES 3.00':'WebGL GLSL ES 1.0',[GL.VENDOR]:'Buninu',[GL.RENDERER]:'CanvasKit CPU',[0x8d57]:4,[0x8824]:4,[0x8cdf]:4,[GL.MAX_TEXTURE_SIZE]:4096,[GL.MAX_CUBE_MAP_TEXTURE_SIZE]:4096,[GL.MAX_TEXTURE_IMAGE_UNITS]:webgl2?16:8,[32883]:256,[35071]:256,[GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS]:webgl2?16:0,[GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]:webgl2?32:8,[GL.MAX_VERTEX_ATTRIBS]:webgl2?16:8,[GL.MAX_VERTEX_UNIFORM_VECTORS]:256,[GL.MAX_FRAGMENT_UNIFORM_VECTORS]:256,[GL.MAX_VARYING_VECTORS]:8,[GL.MAX_VIEWPORT_DIMS]:new Int32Array([4096,4096]),[GL.VIEWPORT]:new Int32Array(vp),[GL.SCISSOR_BOX]:new Int32Array(scissor),[0x846D]:new Float32Array([1,1]),[0x846E]:new Float32Array([1,1])}[p]??0),
  createBuffer:()=>object('WebGLBuffer',buffers,{data:new Uint8Array()}),bindBuffer:(target,b)=>{if(b&&!buffers.has(b)){fail(GL.INVALID_OPERATION);return;}if(target===GL.ARRAY_BUFFER)array=b;else if(target===GL.ELEMENT_ARRAY_BUFFER)vao.current().elements=b;else fail(GL.INVALID_ENUM);},
  bufferData:(target,data)=>{const b=buffers.get(target===GL.ARRAY_BUFFER?array:vao.current().elements);if(!b){fail(GL.INVALID_OPERATION);return;}const size=typeof data==='number'?data:data?.byteLength;if(!(size>=0&&size<=64*1024*1024)){fail(GL.INVALID_VALUE);return;}b.range=null;b.data=typeof data==='number'?new Uint8Array(data):new Uint8Array(data.buffer??data,data.byteOffset??0,size).slice();},
  bufferSubData:(target,offset,data)=>{const b=buffers.get(target===GL.ARRAY_BUFFER?array:vao.current().elements);if(!b||offset<0||offset+data.byteLength>b.data.length){fail(GL.INVALID_VALUE);return;}b.range=null;b.data.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);},deleteBuffer:b=>buffers.delete(b),
  createShader:type=>object('WebGLShader',shaders,{type,source:'',compiled:null,log:''}),shaderSource:(s,source)=>{const sh=shaders.get(s);if(sh)sh.source=String(source);else fail(GL.INVALID_OPERATION);},
  compileShader:s=>{const sh=shaders.get(s);if(!sh)return fail(GL.INVALID_OPERATION);try{if(sh.compiled){flushPending();resources.delete(sh.compiled.effect);sh.compiled.effect.delete();}sh.compiled=compileStage(kit,sh.source,sh.type===GL.VERTEX_SHADER?'vertex':'fragment',webgl2);resources.add(sh.compiled.effect);sh.log='';}catch(e){sh.compiled=null;sh.log=e.message;}},
  getShaderParameter:(s,p)=>p===GL.COMPILE_STATUS?!!shaders.get(s)?.compiled:null,getShaderInfoLog:s=>shaders.get(s)?.log??'',getShaderSource:s=>shaders.get(s)?.source??'',deleteShader:()=>{},
  createProgram:()=>object('WebGLProgram',programs,{shaders:[],uniforms:[],attributes:[],bindings:new Map(),values:new Map(),linked:false,log:''}),attachShader:(p,s)=>programs.get(p)?.shaders.push(s),
  bindAttribLocation:(p,slot,name)=>{
   const pr=programs.get(p);
   if(!pr)return fail(GL.INVALID_OPERATION);
   if(slot<0||slot>=(webgl2?16:8))return fail(GL.INVALID_VALUE);
   if(String(name).startsWith('gl_'))return fail(GL.INVALID_OPERATION);
   pr.bindings.set(String(name),slot);
  },
  linkProgram:p=>{const pr=programs.get(p);if(!pr)return;pr.vertex=pr.shaders.map(s=>shaders.get(s)).find(s=>s.type===GL.VERTEX_SHADER)?.compiled;pr.fragment=pr.shaders.map(s=>shaders.get(s)).find(s=>s.type===GL.FRAGMENT_SHADER)?.compiled;pr.linked=!!(pr.vertex&&pr.fragment);if(!pr.linked){pr.log='A shader failed to compile';return;}pr.uniforms=[...new Map([...pr.vertex.uniforms,...pr.fragment.uniforms].map(u=>[u.name,u])).values()];const attributes=pr.vertex.attributes.filter(a=>!a.builtin).map(a=>({...a,columns:a.type.startsWith('mat')?Math.sqrt(a.size):1,location:a.location??pr.bindings.get(a.name)}));
   const reserved=new Set();let free=0;const limit=webgl2?16:8;
   for(const a of attributes){
    if(a.location===undefined)continue;
    for(let col=0;col<a.columns;col++){const slot=a.location+col;
    if(slot>=limit||reserved.has(slot)){pr.linked=false;pr.log='Invalid or conflicting attribute location';return;}
    reserved.add(slot);}
   }
   for(const a of attributes)if(a.location===undefined){
    while(Array.from({length:a.columns},(_,col)=>reserved.has(free+col)).some(Boolean))free++;
    if(free+a.columns>limit){pr.linked=false;pr.log='Too many vertex attributes';return;}
    a.location=free;free+=a.columns;
   }
   pr.log='';pr.attributes=attributes;},
  getProgramParameter:(p,k)=>{const pr=programs.get(p);return k===GL.LINK_STATUS||k===GL.VALIDATE_STATUS?!!pr?.linked:k===GL.ACTIVE_UNIFORMS?pr?.uniforms.length:k===GL.ACTIVE_ATTRIBUTES?pr?.attributes.length:0;},getProgramInfoLog:p=>programs.get(p)?.log??'',validateProgram:()=>{},
  getActiveUniform:(p,i)=>{const u=programs.get(p)?.uniforms[i];return u?{name:u.name+(u.array?'[0]':''),size:u.size,type:glType(u.type)}:null;},
  getUniformLocation:(p,name)=>{const pr=programs.get(p),n=String(name).replace(/\[0\]$/,'');return pr?.uniforms.some(u=>u.name===n)?object('WebGLUniformLocation',locations,{pr,name:n}):null;},
  getActiveAttrib:(p,i)=>{const a=programs.get(p)?.attributes[i];return a?{name:a.name,size:1,type:glType(a.type)}:null;},getAttribLocation:(p,name)=>programs.get(p)?.attributes.find(a=>a.name===name)?.location??-1,
  useProgram:p=>{if(p&&!programs.get(p)?.linked)return fail(GL.INVALID_OPERATION);program=p;},deleteProgram:p=>programs.delete(p),
  enableVertexAttribArray:i=>{const a=vao.current().attributes.get(i)||{};a.enabled=true;vao.current().attributes.set(i,a);},disableVertexAttribArray:i=>{const a=vao.current().attributes.get(i);if(a)a.enabled=false;},
  vertexAttribPointer:(i,size,type,normalized,stride,offset)=>{vao.current().attributes.set(i,{...vao.current().attributes.get(i),buffer:array,size,type,normalized,stride,offset});},
  enable:cap=>enabled.add(cap),disable:cap=>enabled.delete(cap),isEnabled:cap=>enabled.has(cap),depthFunc:v=>{if(v<GL.NEVER||v>GL.ALWAYS)return fail(GL.INVALID_ENUM);depthFunc=v;},depthMask:v=>{writeDepth=!!v;},frontFace:v=>{front=v;},cullFace:v=>{cull=v;},
  viewport:(x,y,w,h)=>{vp=[x,y,w,h];},clearColor:(...c)=>{clear=c;},clearDepth:v=>{clearZ=v;},
  clear:mask=>{
   if((mask&(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT))===(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT)&&writeDepth&&blend.mask.every(Boolean)&&!enabled.has(GL.SCISSOR_TEST)){pending=[];pendingBytes=0;}else flushPending();
   if(!bindStorage())return fail(0x506);
   const clip=enabled.has(GL.SCISSOR_TEST)?scissor:[0,0,targetWidth,targetHeight];
   const x0=Math.max(0,clip[0]),x1=Math.min(targetWidth,clip[0]+clip[2]);
   const y0=Math.max(0,targetHeight-clip[1]-clip[3]),y1=Math.min(targetHeight,targetHeight-clip[1]);
   if(x0>=x1||y0>=y1)return;
   if(mask&GL.DEPTH_BUFFER_BIT&&writeDepth)depthDirty=true;
   const rgba=Uint8Array.from(clear,v=>Math.round(Math.max(0,Math.min(1,v))*255)),word=new Uint32Array(rgba.buffer)[0];
   // A full-width scissor is one contiguous span, even when it starts
   // above the bottom row. Reuse one typed view for partial-width clears.
   const contiguous=x0===0&&x1===targetWidth,allChannels=blend.mask.every(Boolean);
   function clearColorPlane(dest){
    const packed=allChannels&&dest instanceof Uint8Array
     ?new Uint32Array(dest.buffer,dest.byteOffset,dest.length/4):null;
    const value=dest instanceof Float32Array?clear:rgba;
    const solid=allChannels&&value.every(channel=>channel===value[0]);
    const rows=contiguous?1:y1-y0;
    for(let row=0;row<rows;row++){
     const start=(y0+row)*targetWidth+x0,end=contiguous?y1*targetWidth:start+x1-x0;
     if(packed)packed.fill(word,start,end);
     else if(solid)dest.fill(value[0],4*start,4*end);
     else if(allChannels){
      // Duplicate the four-channel floating-point pattern within the span.
      dest.set(value,4*start);
      for(let count=1;count<end-start;count*=2){
       dest.copyWithin(4*(start+count),4*start,4*(start+Math.min(count,end-start-count)));
      }
     }else for(let i=start;i<end;i++)for(let c=0;c<4;c++)if(blend.mask[c])dest[4*i+c]=value[c];
    }
   }
   if(mask&GL.DEPTH_BUFFER_BIT&&writeDepth&&depth){
    if(contiguous)depth.fill(clearZ,y0*targetWidth,y1*targetWidth);
    else for(let y=y0;y<y1;y++)depth.fill(clearZ,y*targetWidth+x0,y*targetWidth+x1);
   }
   if(mask&GL.COLOR_BUFFER_BIT){
    if(colorPixels)clearColorPlane(colorPixels);
    for(let slot=1;slot<fb.slots();slot++){
     const target=storageFor(fb.draw(),slot);if(target?.color)clearColorPlane(target.color);
    }
    pixelsDirty=true;invalidate();
   }
  },
  drawArrays:(mode,first,count)=>drawArrays(mode,first,count,1),
  drawElements:(mode,count,type,offset)=>drawElements(mode,count,type,offset,1),
  flush:()=>{flushPending();state.raster.flush();},finish:()=>{flushPending();state.raster.flush();},
 };
 // Fixed-function state that does not affect the initial opaque triangle subset.
 for(const name of ['clearStencil','colorMask','blendEquation','blendEquationSeparate','blendFunc','blendFuncSeparate','blendColor','stencilMask','stencilFunc','stencilOp','pixelStorei','scissor','polygonOffset','lineWidth','hint','activeTexture','bindTexture','texParameteri','texParameterf','texImage2D','texSubImage2D','generateMipmap','deleteTexture','bindFramebuffer','bindRenderbuffer','deleteFramebuffer','deleteRenderbuffer'])methods[name]=()=>{};
 methods.blendFuncSeparate=(sr,dr,sa,da)=>{blend={...blend,factors:[sr,dr,sa,da]};};
 methods.blendFunc=(s,d)=>methods.blendFuncSeparate(s,d,s,d);
 methods.blendEquationSeparate=(rgb,a)=>{blend={...blend,equations:[rgb,a]};};
 methods.blendEquation=eq=>methods.blendEquationSeparate(eq,eq);
 methods.colorMask=(...mask)=>{blend={...blend,mask:mask.map(Boolean)};};
 methods.blendColor=(...color)=>{blend={...blend,color:color.map(v=>Math.max(0,Math.min(1,v)))};};
 methods.scissor=(x,y,w,h)=>{if(w<0||h<0)return fail(GL.INVALID_VALUE);scissor=[x,y,w,h];};
 methods.readPixels=(x,y,w,h,format,type,output,offset=0)=>{
  if(format!==GL.RGBA||type!==GL.UNSIGNED_BYTE&&!(webgl2&&type===GL.FLOAT))return fail(GL.INVALID_ENUM);
  if(w<0||h<0||offset<0)return fail(GL.INVALID_VALUE);
  if(!(type===GL.FLOAT?output instanceof Float32Array:output instanceof Uint8Array||output instanceof Uint8ClampedArray)||offset+4*w*h>output.length)return fail(GL.INVALID_OPERATION);
  flushPending();const src=storageFor(fb.read(),0,true);if(!src)return fail(0x506);
  if(!src.color)return fail(GL.INVALID_OPERATION);
  for(let row=0;row<h;row++){
   const dest=offset+row*w*4;
   output.fill(0,dest,dest+w*4);
   const sy=src.height-1-y-row,sx=Math.max(0,x),end=Math.min(x+w,src.width);
   if(sy<0||sy>=src.height||sx>=end)continue;
   const data=src.color.subarray((sy*src.width+sx)*4,(sy*src.width+end)*4);
   const start=dest+(sx-x)*4;
   if(data.BYTES_PER_ELEMENT===output.BYTES_PER_ELEMENT)output.set(data,start);
   else for(let i=0;i<data.length;i++)output[start+i]=type===GL.FLOAT?data[i]/255:Math.round(Math.min(1,Math.max(0,data[i]))*255);
  }
 };
 Object.assign(methods,texture.methods);Object.assign(methods,fb.methods);if(!webgl2){delete methods.readBuffer;delete methods.drawBuffers;delete methods.renderbufferStorageMultisample;}
 for(const n of [1,2,3,4])for(const suffix of ['f','i','fv','iv'])methods[`uniform${n}${suffix}`]=(loc,...v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||getP()!==l.pr)return fail(GL.INVALID_OPERATION);const convert=suffix[0]==='i'?x=>Number(x)|0:Math.fround;
  l.pr.values.set(l.name,suffix.endsWith('v')?Array.from(v[0],convert):n===1?convert(v[0]):v.map(convert));};
 for(const n of [2,3,4])methods[`uniformMatrix${n}fv`]=(loc,transpose,v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||transpose||getP()!==l.pr)return fail(GL.INVALID_OPERATION);l.pr.values.set(l.name,Array.from(v));};
 function blitFramebuffer(sx0,sy0,sx1,sy1,dx0,dy0,dx1,dy1,mask,filter){
  if(filter!==GL.NEAREST&&filter!==GL.LINEAR)return fail(GL.INVALID_ENUM);
  if(filter===GL.LINEAR&&(mask&~GL.COLOR_BUFFER_BIT))return fail(GL.INVALID_OPERATION);
  if(!((sx1-sx0)&&(sy1-sy0)&&(dx1-dx0)&&(dy1-dy0)))return;
  flushPending();
  const src=storageFor(fb.read(),0,true);if(!src||!bindStorage())return fail(0x506);
  const clip=enabled.has(GL.SCISSOR_TEST)?scissor:[0,0,targetWidth,targetHeight];
  const loX=Math.max(0,clip[0],Math.min(dx0,dx1)),hiX=Math.min(targetWidth,clip[0]+clip[2],Math.max(dx0,dx1));
  const loY=Math.max(0,clip[1],Math.min(dy0,dy1)),hiY=Math.min(targetHeight,clip[1]+clip[3],Math.max(dy0,dy1));
  if(!src.color||!colorPixels)mask&=~GL.COLOR_BUFFER_BIT;
  if(!src.depth||!depth)mask&=~GL.DEPTH_BUFFER_BIT;
  if(!mask)return;
  const bytes=mask&GL.COLOR_BUFFER_BIT&&src.color===colorPixels?src.color.slice():src.color;
  const sourceDepth=mask&GL.DEPTH_BUFFER_BIT&&src.depth===depth?src.depth.slice():src.depth;
  // Resolving a multisampled renderbuffer commonly copies the entire target
  // without scaling. Compatible CPU planes can be copied in one operation.
  const whole=sx0===0&&sy0===0&&dx0===0&&dy0===0&&sx1===src.width&&sy1===src.height&&
   dx1===sx1&&dy1===sy1&&targetWidth===sx1&&targetHeight===sy1&&
   loX===0&&loY===0&&hiX===sx1&&hiY===sy1;
  if(whole){
   if(mask&GL.DEPTH_BUFFER_BIT){depth.set(sourceDepth);depthDirty=true;mask&=~GL.DEPTH_BUFFER_BIT;}
   if((mask&GL.COLOR_BUFFER_BIT)&&bytes.constructor===colorPixels.constructor){
    colorPixels.set(bytes);pixelsDirty=true;invalidate();mask&=~GL.COLOR_BUFFER_BIT;
   }
   if(!mask)return;
  }
  const sourceScale=bytes instanceof Float32Array?1:255;
  const toTarget=colorPixels instanceof Float32Array
   ? value=>value/sourceScale
   : value=>Math.round(Math.max(0,Math.min(1,value/sourceScale))*255);
  const pixel=(x,y)=>(src.height-1-Math.max(0,Math.min(src.height-1,y)))*src.width+Math.max(0,Math.min(src.width-1,x));
  for(let y=loY;y<hiY;y++)for(let x=loX;x<hiX;x++){
   const u=sx0+(x+.5-dx0)*(sx1-sx0)/(dx1-dx0),v=sy0+(y+.5-dy0)*(sy1-sy0)/(dy1-dy0);
   if(u<0||u>=src.width||v<0||v>=src.height)continue;
   const dest=(targetHeight-1-y)*targetWidth+x,source=pixel(Math.floor(u),Math.floor(v));
   if(mask&GL.DEPTH_BUFFER_BIT)depth[dest]=sourceDepth[source];
   if(!(mask&GL.COLOR_BUFFER_BIT))continue;
   if(filter===GL.NEAREST){for(let c=0;c<4;c++)colorPixels[4*dest+c]=toTarget(bytes[4*source+c]);continue;}
   const i=Math.floor(u-.5),j=Math.floor(v-.5),a=u-.5-i,b=v-.5-j;
   const p=pixel(i,j)*4,q=pixel(i+1,j)*4,r=pixel(i,j+1)*4,t=pixel(i+1,j+1)*4;
   for(let c=0;c<4;c++)colorPixels[4*dest+c]=toTarget((bytes[p+c]*(1-a)+bytes[q+c]*a)*(1-b)+(bytes[r+c]*(1-a)+bytes[t+c]*a)*b);
  }
  if(mask&GL.COLOR_BUFFER_BIT){pixelsDirty=true;invalidate();}
  if(mask&GL.DEPTH_BUFFER_BIT)depthDirty=true;
 }
 if(webgl2)Object.assign(methods,vao.methods,{blitFramebuffer,drawArraysInstanced:drawArrays,drawElementsInstanced:drawElements});
 for(let n=1;n<=4;n++){
  const set=(slot,value)=>{
   if(slot<0||slot>=(webgl2?16:8)||value.length<n)return fail(GL.INVALID_VALUE);
   const out=[0,0,0,1];for(let i=0;i<n;i++)out[i]=Number(value[i]);constants.set(slot,out);
  };
  methods['vertexAttrib'+n+'f']=(slot,...value)=>set(slot,value);
  methods['vertexAttrib'+n+'fv']=set;
 }
 function drawArrays(mode,first,count,instances){
  if(first<0||count<0||count>1000000)return fail(GL.INVALID_VALUE);
  if(!count||!instances)return draw(mode,[],instances,0);
  const indices=new Uint32Array(count);
  for(let i=0;i<count;i++)indices[i]=first+i;
  draw(mode,indices,instances,first+count);
 }
 function drawElements(mode,count,type,offset,instances){
  const b=buffers.get(vao.current().elements);
  if(!b)return fail(GL.INVALID_OPERATION);
  const bytes=type===GL.UNSIGNED_INT?4:type===GL.UNSIGNED_SHORT?2:type===GL.UNSIGNED_BYTE?1:0;
  if(!bytes)return fail(GL.INVALID_ENUM);
  if(offset<0||count<0||count>1000000)return fail(GL.INVALID_VALUE);
  if(offset%bytes||offset+count*bytes>b.data.length)return fail(GL.INVALID_OPERATION);
  const range=elementRange(b,bytes,offset,count,webgl2);
  draw(mode,range.indices,instances,range.vertices,range.restart);
 }
 function draw(mode,indices,instances,vertices,restart){
  if(![GL.TRIANGLES,GL.TRIANGLE_STRIP,GL.TRIANGLE_FAN].includes(mode))return fail(GL.INVALID_ENUM);
  if(instances<0)return fail(GL.INVALID_VALUE);
  if(!instances||!indices.length)return;
  const pr=getP();if(!pr?.linked)return fail(GL.INVALID_OPERATION);if(!bindStorage())return fail(0x506);
  if(!vertices)return;
  const count=vertices*instances;
  if(count>1000000||indices.length*instances>3000000)return fail(GL.OUT_OF_MEMORY);
  if(mode!==GL.TRIANGLES||instances>1||restart!==undefined)indices=triangles(mode,indices,instances,vertices,restart);
  const inputs=new Map();
  for(const spec of pr.attributes){
   if(spec.columns>1){
    const packed=matrixInput(spec,vao.current().attributes,buffers,vertices,instances);
    if(packed){inputs.set(spec.name,packed);continue;}
   }
   const rows=spec.size/spec.columns;
   let joined=spec.columns>1?new Float32Array(count*spec.size):null;
   for(let col=0;col<spec.columns;col++){
    const slot=spec.location+col,a=vao.current().attributes.get(slot);
    let data;
    if(a?.enabled){
     const b=buffers.get(a.buffer);
     data=b&&vertexInput({size:rows},a,b.data,vertices,instances);
     if(!data)return fail(GL.INVALID_OPERATION);
    }else{
     const value=constants.get(slot)??[0,0,0,1];data=new Float32Array(count*rows);
     for(let i=0;i<count;i++)for(let c=0;c<rows;c++)data[i*rows+c]=value[c];
    }
    if(!joined)joined=data;
    else for(let i=0;i<count;i++)for(let c=0;c<rows;c++)joined[i*spec.size+col*rows+c]=data[i*rows+c];
   }
   inputs.set(spec.name,joined);
  }
  for(const spec of pr.vertex.attributes)if(spec.builtin){
   inputs.set(spec.name,Float32Array.from({length:count},(_,i)=>spec.name==='gl_InstanceID'?Math.floor(i/vertices):i%vertices));
  }
  const saved={...pr,values:new Map(pr.values)},samplers=texture.capture(pr.fragment,pr.values,fb.attachedToDraw),settings={blend,vp:vp.slice(),scissor:scissor.slice(),enabled:new Set(enabled),depthFunc,writeDepth,front,cull};
  if(!depth)settings.enabled.delete(GL.DEPTH_TEST);
  const vertexSamplers=texture.capture(pr.vertex,pr.values,fb.attachedToDraw);
  const reusable=!settings.enabled.has(GL.DEPTH_TEST)||(settings.writeDepth&&(settings.depthFunc===GL.LESS||settings.depthFunc===GL.LEQUAL));
  const key=!webgl2&&reusable&&fb.slots()===1?fragments.key(saved,[...vertexSamplers,...samplers],settings,[targetWidth,targetHeight],inputs,indices):null;
  pending.push(()=>{try{
    const cached=key&&fragments.get(key);
    if(cached){present(cached.pixels,cached.left,cached.top,cached.width,cached.height,null,cached.depth,settings.depthFunc);invalidate();return;}
    texture.setUniforms(vertexSamplers,saved.values);
    const verts=runVertices(kit,saved.vertex,saved.values,inputs,count,()=>texture.shaders(vertexSamplers),vertexSamplers);
    const clipped=clipTriangles(verts,indices,saved.vertex.outputCount,saved.vertex.flatComponents);
    if(fb.slots()===1)raster(saved,clipped.vertices,clipped.indices,settings,samplers,key);
    else{
     const initialDepth=settings.enabled.has(GL.DEPTH_TEST)&&settings.writeDepth?depth.slice():null;
     for(let slot=0;slot<fb.slots();slot++){
      if(!saved.fragment.outputs[slot]||!fb.describe(fb.draw(),slot)?.color||!bindStorage(slot))continue;
      if(initialDepth)depth.set(initialDepth);
      saved.values.set('_sw_output',slot);raster(saved,clipped.vertices,clipped.indices,settings,samplers,null);
     }
     bindStorage();
    }
   }catch(e){fail(GL.INVALID_OPERATION);engineGlobal("console").error('CPU WebGL draw:',e.message);}});
  pendingBytes+=indices.length*4+[...inputs.values()].reduce((n,a)=>n+a.byteLength,0);
  invalidate();if(pendingBytes>32*1024*1024)flushPending();
 }
 function passesDepth(func,z,stored){
  switch(func){
   case GL.LESS:return z<stored;
   case GL.LEQUAL:return z<=stored;
   case GL.EQUAL:return z===stored;
   case GL.GREATER:return z>stored;
   case GL.GEQUAL:return z>=stored;
   case GL.NOTEQUAL:return z!==stored;
   case GL.ALWAYS:return true;
   default:return false;
  }
 }
 function applyDepth(geometryDepth,left,top,width,height,func,write=true){
  if(!geometryDepth)return null;
  const visible=new Uint8Array(width*height*4);let count=0,occluded=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const i=y*width+x,z=geometryDepth[i];if(z===Infinity)continue;
   const pos=(y+top)*targetWidth+x+left;
   if(func===GL.LEQUAL?z<=depth[pos]:z<depth[pos]){visible[i*4+3]=255;if(write)depth[pos]=z;count++;}else occluded++;
  }
  return count?(occluded?visible:null):false;
 }
 // The canvas surface is unpremultiplied RGBA. Compose decoded fragments in
 // JS and upload once per flush instead of invoking Skia for every mesh/mask.
 function present(pixels,left,top,width,height,mask,geometryDepth=null,func=GL.LESS){
  const source=new Uint32Array(pixels.buffer,pixels.byteOffset,pixels.byteLength/4),target=new Uint32Array(colorPixels.buffer);
  for(let y=0;y<height;y++){let pos=(y+top)*targetWidth+left,i=y*width;for(let x=0;x<width;x++,pos++,i++){
   const s=i*4;if(mask&&!mask[s+3])continue;
   if(geometryDepth){const z=geometryDepth[i];if(z===Infinity||(func===GL.LEQUAL?z>depth[pos]:z>=depth[pos]))continue;depth[pos]=z;}
   const alpha=pixels[s+3];if(!alpha)continue;
   const d=pos*4;
   if(alpha===255){target[pos]=source[i];continue;}
   const remainder=(1-alpha/255)*colorPixels[d+3]/255,opacity=alpha/255+remainder;
   for(let c=0;c<3;c++)colorPixels[d+c]=Math.round(Math.max(0,Math.min(255,(pixels[s+c]+colorPixels[d+c]*remainder)/opacity)));
   colorPixels[d+3]=Math.round(opacity*255);
  }}
  pixelsDirty=true;
 }

 function raster(pr,verts,indices,{blend, vp,scissor,enabled,depthFunc,writeDepth,front,cull},samplers,key){
  if(!indices.length)return;
  const width=targetWidth,height=targetHeight,n=pr.vertex.outputCount;
  const clip=enabled.has(GL.SCISSOR_TEST)?scissor:[0,0,width,height];
  const bounds=[Math.max(0,clip[0]),Math.min(width-1,clip[0]+clip[2]-1),Math.max(0,height-clip[1]-clip[3]),Math.min(height-1,height-1-clip[1])];
  const triangles=[];let left=width,top=height,right=-1,bottom=-1;
  const offsets=new Map();let off=4;for(const v of pr.vertex.varyings){offsets.set(v.name,off);off+=v.size;}
  // Indexed meshes share projected vertices. Cache each projection once for
  // this draw, including invalid positions, before binning its triangles.
  const projected=new Array(verts.length/n);
  function point(id){
   if(projected[id]!==undefined)return projected[id];
   const o=id*n, reciprocal=1/verts[o+3];
   const x=vp[0]+(verts[o]*reciprocal+1)*vp[2]/2;
   const y=height-vp[1]-(verts[o+1]*reciprocal+1)*vp[3]/2;
   const z=verts[o+2]*reciprocal;
   return projected[id]=reciprocal>0&&Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z)?[x,y,z,reciprocal]:null;
  }
  for(let t=0;t+2<indices.length;t+=3){
   const a=point(indices[t]),b=point(indices[t+1]),c=point(indices[t+2]);
   if(!a||!b||!c)continue;
   const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);if(!area)continue;
   const facing=front===GL.CCW?area<0:area>0;if(enabled.has(GL.CULL_FACE)&&((cull===GL.BACK&&!facing)||(cull===GL.FRONT&&facing)||cull===GL.FRONT_AND_BACK))continue;
   // Coverage is evaluated at pixel centers. Subpixel triangles whose
   // bounding box contains no sample never need a tile or an edge test.
   const x0=Math.max(bounds[0],Math.ceil(Math.min(a[0],b[0],c[0])-.5)),x1=Math.min(bounds[1],Math.floor(Math.max(a[0],b[0],c[0])-.5));
   const y0=Math.max(bounds[2],Math.ceil(Math.min(a[1],b[1],c[1])-.5)),y1=Math.min(bounds[3],Math.floor(Math.max(a[1],b[1],c[1])-.5));
   if(x1<x0||y1<y0)continue;
   const topLeft=(u,v)=>area>0?(v[1]<u[1]||v[1]===u[1]&&v[0]>u[0]):(v[1]>u[1]||v[1]===u[1]&&v[0]<u[0]);
   const edgeMask=Number(topLeft(b,c))|(Number(topLeft(c,a))<<1)|(Number(topLeft(a,b))<<2);
   // Large diagonal triangles can touch many tiles while covering only a
   // narrow strip. Intersect the scanline with their two active edges first.
   let scan=null;
   if(x1-x0>=16&&y1-y0>=4){
    let low=a,mid=b,high=c;
    if(low[1]>mid[1])[low,mid]=[mid,low];
    if(mid[1]>high[1])[mid,high]=[high,mid];
    if(low[1]>mid[1])[low,mid]=[mid,low];
    const slope=(u,v)=>(v[0]-u[0])/(v[1]-u[1]);
    scan={low,mid,high,ac:slope(low,high),ab:mid[1]===low[1]?0:slope(low,mid),bc:mid[1]===high[1]?0:slope(mid,high)};
   }
   triangles.push({edgeMask,scan,ids:[indices[t],indices[t+1],indices[t+2]],p:[a,b,c],area,facing,x0,x1,y0,y1});left=Math.min(left,x0);right=Math.max(right,x1);top=Math.min(top,y0);bottom=Math.max(bottom,y1);
  }
  if(!triangles.length)return;
  const blending=enabled.has(GL.BLEND);
  let ordered=null;
  if(webgl2&&(pr.fragment.discard||blending&&colorPixels&&blend.mask.some(Boolean))&&pr.fragment.cpu){
   texture.setUniforms(samplers,pr.values);
   ordered=orderedCPUFragment(pr.fragment,pr.values,samplers);
  }
  // Compact attribute images to the mesh bounds. Align to derivative quads
  // and keep a zero border for helper samples outside triangle coverage.
  left=Math.max(0,(left&~1)-2);top=Math.max(0,(top&~1)-2);right=Math.min(width-1,(right|1)+2);bottom=Math.min(height-1,(bottom|1)+2);
  // Large shadow maps can cover millions of pixels with widely separated
  // triangles. Keep the per-varying scratch images local to occupied tiles.
  // An even tile extent keeps each derivative quad in the same tile.
  let cpuBatch;
  if((webgl2||pr.fragment.derivativeInputs)&&(right-left+1)*(bottom-top+1)>256*256){
   const extent=128, columns=Math.ceil(width/extent), tiles=new Map();
   for(const tri of triangles){
    for(let ty=Math.floor(tri.y0/extent);ty<=Math.floor(tri.y1/extent);ty++){
     for(let tx=Math.floor(tri.x0/extent);tx<=Math.floor(tri.x1/extent);tx++){
      const id=ty*columns+tx;
      let bin=tiles.get(id);
      if(!bin){bin={items:[],x0:tri.x0,x1:tri.x1,y0:tri.y0,y1:tri.y1};tiles.set(id,bin);}
      else{
       bin.x0=Math.min(bin.x0,tri.x0);bin.x1=Math.max(bin.x1,tri.x1);
       bin.y0=Math.min(bin.y0,tri.y0);bin.y1=Math.max(bin.y1,tri.y1);
      }
      bin.items.push(tri);
     }
    }
   }
   // A cache entry represents the entire draw, never just its last tile.
   key=null;
   for(const [id,bin] of tiles){
    const x=(id%columns)*extent,y=Math.floor(id/columns)*extent;
    // Keep helper quads aligned at the tile origin and trim empty margins.
    shadeRegion(bin.items,Math.max(x,(bin.x0&~1)-2),Math.max(y,(bin.y0&~1)-2),
     Math.min(width-1,x+extent-1,(bin.x1|1)+2),Math.min(height-1,y+extent-1,(bin.y1|1)+2));
   }
  }else shadeRegion(triangles,left,top,right,bottom);

  function shadeRegion(batch,left,top,right,bottom){
  let touched=false;
  const rw=right-left+1,rh=bottom-top+1;
  // Cache geometry shading independently of other draw calls' depth masks.
  // Moving a foreground object must not invalidate a static wall's lighting.
  const depthTest=enabled.has(GL.DEPTH_TEST);
  // A shader that cannot discard has no observable fragment output during
  // a depth-only pass. Write the depth attachment directly, in draw order.
  const depthOnly=webgl2&&!pr.fragment.discard&&(!colorPixels||!blend.mask.some(Boolean));
  if(depthOnly&&(!depthTest||!writeDepth))return;
  // WebGL 1's draw cache needs a depth plane independent of the scene.
  // An ordinary WebGL 2 draw can reject hidden pixels against the live
  // attachment before allocating or interpolating their helper inputs.
  const separateDepth=!ordered&&(!webgl2||pr.fragment.discard)&&depthTest&&writeDepth&&(depthFunc===GL.LESS||depthFunc===GL.LEQUAL);
  const geometryDepth=separateDepth?new Float32Array(rw*rh).fill(Infinity):null;
  const planes=pr.fragment.derivativeInputs?3:1, stride=rw*rh*4;
  const coverage=depthOnly||ordered?null:new Float32Array(stride*planes),varying=depthOnly?null:ordered?ordered.inputs:pr.fragment.varyings.map(()=>new Float32Array(stride*planes));
  const helperDepth=ordered?.prepare?new Float32Array(3):null;
  for(const tri of batch){
   const {ids,p,area,facing}=tri, x0=Math.max(left,tri.x0),x1=Math.min(right,tri.x1),y0=Math.max(top,tri.y0),y1=Math.min(bottom,tri.y1);
   for(let y=y0;y<=y1;y++){
    let rowStart=x0,rowEnd=x1;
    if(tri.scan){
     const {low,mid,high,ac,ab,bc}=tri.scan,cy=y+.5;
     const l=low[0]+(cy-low[1])*ac;
     const r=cy<mid[1]||mid[1]===high[1]?low[0]+(cy-low[1])*ab:mid[0]+(cy-mid[1])*bc;
     // Round outwards. The original edge functions below decide ties,
     // including when the projected edge passes through a sample center.
     rowStart=Math.max(rowStart,Math.floor(Math.min(l,r)-.5));
     rowEnd=Math.min(rowEnd,Math.ceil(Math.max(l,r)-.5));
    }
    for(let x=rowStart;x<=rowEnd;x++){const px=x+.5,py=y+.5,b0=((p[1][0]-px)*(p[2][1]-py)-(p[1][1]-py)*(p[2][0]-px))/area,b1=((p[2][0]-px)*(p[0][1]-py)-(p[2][1]-py)*(p[0][0]-px))/area,b2=((p[0][0]-px)*(p[1][1]-py)-(p[0][1]-py)*(p[1][0]-px))/area;
     if(b0<0||b1<0||b2<0||(!b0&&!(tri.edgeMask&1))||(!b1&&!(tri.edgeMask&2))||(!b2&&!(tri.edgeMask&4)))continue;const z=Math.fround((b0*p[0][2]+b1*p[1][2]+b2*p[2][2])*.5+.5);if(z<0||z>1)continue;const pos=y*width+x;
     const local=(y-top)*rw+x-left;
     const oldDepth=separateDepth?geometryDepth[local]:depth?.[pos];
     if(depthTest&&!passesDepth(depthFunc,z,oldDepth))continue;
     if(separateDepth)geometryDepth[local]=z;
     else if(depthTest&&writeDepth&&!ordered)depth[pos]=z;
     touched=true;
     if(depthOnly)continue;
     // Neighbor samples used by dFdx/dFdy extend this triangle's attribute
     // planes. Dividing by the extrapolated reciprocal w keeps perspective
     // interpolation correct beyond the visible edge.
     for(let plane=0;plane<planes;plane++){
      const dx=plane===1?(x%2?-1:1):0,dy=plane===2?(y%2?-1:1):0;
      const a=b0+(dx*(p[1][1]-p[2][1])+dy*(p[2][0]-p[1][0]))/area;
      const b=b1+(dx*(p[2][1]-p[0][1])+dy*(p[0][0]-p[2][0]))/area;
      const c=plane?1-a-b:b2, pixel=local*4+plane*stride;
      if(helperDepth)helperDepth[plane]=plane?(a*p[0][2]+b*p[1][2]+c*p[2][2])*.5+.5:z;
      if(!ordered){
       coverage[pixel]=facing?1:-1;coverage[pixel+1]=height-py-dy;
       coverage[pixel+2]=plane?(a*p[0][2]+b*p[1][2]+c*p[2][2])*.5+.5:z;
       coverage[pixel+3]=1;
      }
      const input=ordered?plane*4:pixel;
      const w=a*p[0][3]+b*p[1][3]+c*p[2][3],w0=a*p[0][3]/w,w1=b*p[1][3]/w,w2=c*p[2][3]/w;
      for(let k=0;k<pr.fragment.varyings.length;k++){
       const v=pr.fragment.varyings[k],o=offsets.get(v.name);if(o===undefined)continue;
       for(let j=0;j<v.size;j++)varying[k][input+j]=v.flat?verts[ids[2]*n+o+j]:
        w0*verts[ids[0]*n+o+j]+w1*verts[ids[1]*n+o+j]+w2*verts[ids[2]*n+o+j];
      }
     }
     const kept=helperDepth?ordered.prepare(0,4,px,height-py,facing,x%2?-1:1,y%2?-1:1,z,helperDepth[1],helperDepth[2]):undefined;
     if(ordered&&(kept??ordered.shade(0,px,height-py,z,facing,false))!==false){
      if(depthTest&&writeDepth)depth[pos]=z;
      if(colorPixels)writeFragment(ordered.result,0,colorPixels,pos*4,blend,blending);
     }
    }
   }
  }
  if(!touched)return;
  if(depthTest&&writeDepth)depthDirty=true;
  if(depthOnly)return;
  if(ordered){pixelsDirty=true;invalidate();return;}
  const deferDepth=webgl2&&pr.fragment.discard&&separateDepth;
  const mask=applyDepth(geometryDepth,left,top,rw,rh,depthFunc,!deferDepth);
  if(mask===false)return;
  if(webgl2&&mask){
   // The interpolated helper planes belong to the surviving primitive.
   // Occluded pixels need no fragment invocation, even for derivatives.
   for(let i=3;i<stride;i+=4)if(!mask[i])coverage[i]=0;
  }
  const show=pixels=>{
   if(webgl2){
    const blending=enabled.has(GL.BLEND);
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
     const src=(y*rw+x)*4;if(!coverage[src+3]||mask&&!mask[src+3])continue;
     const dest=(top+y)*targetWidth+left+x;
     if(deferDepth)depth[dest]=geometryDepth[src/4];
     if(colorPixels)writeFragment(pixels,src,colorPixels,dest*4,blend,blending);
    }
    pixelsDirty=true;return;
   }
   if(!colorPixels)return;
   present(pixels,left,top,rw,rh,mask);fragments.put(key,pixels,left,top,rw,rh,geometryDepth);};
  if(pr.fragment.cpu){
   if(!cpuBatch){texture.setUniforms(samplers,pr.values);cpuBatch=createFragmentBatch(pr.fragment,pr.values,samplers);}
   show(cpuBatch(coverage,varying,rw,rh,left,top,height));invalidate();return;
  }
  texture.setUniforms(samplers,pr.values);
  const images=[],children=[];let effect,paint;
  if(planes>1)pr.values.set('_sw_tileHeight',rh);
  try{for(const data of [coverage,...varying]){const img=floatImage(kit,rw,rh*planes,data);images.push(img);children.push(imageShader(kit,img,[1,0,left,0,1,top,0,0,1]));}children.push(...texture.shaders(samplers));effect=shader(kit,pr.fragment,pr.values,children);paint=new kit.Paint();paint.setShader(effect);paint.setBlendMode(kit.BlendMode.SrcOver);
   if(webgl2){
    const info={width:rw,height:rh,colorType:kit.ColorType.RGBA_F32,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB};
    const mem=kit.Malloc(Float32Array,rw*rh*4);let surface;
    try{
     surface=kit.MakeRasterDirectSurface(info,mem,rw*16);
     if(!surface)throw Error('Cannot allocate floating-point fragment surface');
     const canvas=surface.getCanvas();
     canvas.translate(-left,-top);paint.setBlendMode(kit.BlendMode.Src);
     const rect=kit.LTRBRect(left,top,right+1,bottom+1);
     if(pr.fragment.discard){
      const control=new Map(pr.values);control.set('_sw_test_discard',1);
      const keep=shader(kit,pr.fragment,control,children);
      try{paint.setShader(keep);canvas.drawRect(rect,paint);surface.flush();
       const data=mem.toTypedArray();for(let i=0;i<rw*rh;i++)if(!data[4*i+3])coverage[4*i+3]=0;
      }finally{paint.setShader(effect);keep.delete();}
     }
     canvas.drawRect(rect,paint);surface.flush();show(mem.toTypedArray());
    }finally{surface?.delete();kit.Free(mem);}
    invalidate();return;
   }
   const surface=kit.MakeSurface(rw,rh);
   if(surface){let image;try{const canvas=surface.getCanvas();canvas.clear(kit.TRANSPARENT);canvas.translate(-left,-top);canvas.drawRect(kit.LTRBRect(left,top,right+1,bottom+1),paint);surface.flush();image=surface.makeImageSnapshot();const pixels=image.readPixels(0,0,{width:rw,height:rh,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB});if(!pixels)throw Error('Cannot read fragment surface');show(Uint8Array.from(pixels));}finally{image?.delete();surface.dispose();}}
   else throw Error('Cannot allocate fragment surface');
   invalidate();}finally{paint?.delete();effect?.delete();for(const c of children)c.delete();for(const i of images)i.delete();}
  }
 }
 const proxy=Object.create(null);for(const [name,value] of Object.entries({...GL,...blendEnums,...fbEnums,...(webgl2?{VERTEX_ARRAY_BINDING:0x85B5,TEXTURE_3D:32879,TEXTURE_2D_ARRAY:35866,TEXTURE_WRAP_R:32882,RED:6403,RG:33319,RG8:33323,R8:33321,MAX_3D_TEXTURE_SIZE:32883,MAX_ARRAY_TEXTURE_LAYERS:35071}:{}),...methods}))Object.defineProperty(proxy,name,{value,enumerable:true});Object.defineProperties(proxy,{canvas:{get:()=>publicCanvas?.deref()??null},drawingBufferWidth:{get:()=>state.width},drawingBufferHeight:{get:()=>state.height},[Symbol.toStringTag]:{value:webgl2?'WebGL2RenderingContext':'WebGLRenderingContext'}});
 return {proxy,flush:flushPending,dispose(){pending=[];pendingBytes=0;colorPixels=new Uint8Array();pixelsDirty=false;texture.dispose();fragments.clear();for(const r of resources)r.delete();resources.clear();},reset(){pending=[];pendingBytes=0;colorPixels=new Uint8Array(state.width*state.height*4);pixelsDirty=false;fragments.clear();depth=defaultDepth();defaultBuffer.color=colorPixels;defaultBuffer.depth=depth;vp=[0,0,state.width,state.height];},configure:o=>{resolveImage=o.resolveImage;publicCanvas=o.canvas?new WeakRef(o.canvas):null;}};
}

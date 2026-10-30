import {runCPUFragment} from './cpu-fragment.js';
import {DrawCache} from './draw-cache.js';
import {textureState} from './textures.js';
import {clipTriangles} from './clip.js';
import {components,glType} from './shaders.js';
import {compileStage,runVertices,shader,floatImage,imageShader} from './pipeline.js';
const GL={DEPTH_BUFFER_BIT:256,STENCIL_BUFFER_BIT:1024,COLOR_BUFFER_BIT:16384,POINTS:0,LINES:1,LINE_LOOP:2,LINE_STRIP:3,TRIANGLES:4,TRIANGLE_STRIP:5,TRIANGLE_FAN:6,ZERO:0,ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,FUNC_ADD:32774,NEVER:512,LESS:513,EQUAL:514,LEQUAL:515,GREATER:516,NOTEQUAL:517,GEQUAL:518,ALWAYS:519,FRONT:1028,BACK:1029,FRONT_AND_BACK:1032,CW:2304,CCW:2305,CULL_FACE:2884,BLEND:3042,DEPTH_TEST:2929,SCISSOR_TEST:3089,STENCIL_TEST:2960,POLYGON_OFFSET_FILL:32823,BYTE:5120,UNSIGNED_BYTE:5121,SHORT:5122,UNSIGNED_SHORT:5123,INT:5124,UNSIGNED_INT:5125,FLOAT:5126,ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,DYNAMIC_DRAW:35048,STREAM_DRAW:35040,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,LINK_STATUS:35714,VALIDATE_STATUS:35715,ACTIVE_UNIFORMS:35718,ACTIVE_ATTRIBUTES:35721,HIGH_FLOAT:36338,MEDIUM_FLOAT:36337,LOW_FLOAT:36336,HIGH_INT:36341,MEDIUM_INT:36340,LOW_INT:36339,FLOAT_VEC2:35664,FLOAT_VEC3:35665,FLOAT_VEC4:35666,FLOAT_MAT3:35675,FLOAT_MAT4:35676,SAMPLER_2D:35678,TEXTURE_2D:3553,TEXTURE_CUBE_MAP:34067,TEXTURE_CUBE_MAP_POSITIVE_X:34069,TEXTURE0:33984,RGBA:6408,RGB:6407,ALPHA:6406,NEAREST:9728,LINEAR:9729,NEAREST_MIPMAP_NEAREST:9984,LINEAR_MIPMAP_NEAREST:9985,NEAREST_MIPMAP_LINEAR:9986,LINEAR_MIPMAP_LINEAR:9987,CLAMP_TO_EDGE:33071,REPEAT:10497,MIRRORED_REPEAT:33648,TEXTURE_MAG_FILTER:10240,TEXTURE_MIN_FILTER:10241,TEXTURE_WRAP_S:10242,TEXTURE_WRAP_T:10243,UNPACK_FLIP_Y_WEBGL:37440,UNPACK_PREMULTIPLY_ALPHA_WEBGL:37441,UNPACK_ALIGNMENT:3317,PACK_ALIGNMENT:3333,FRAMEBUFFER:36160,RENDERBUFFER:36161,FRAMEBUFFER_COMPLETE:36053,MAX_TEXTURE_SIZE:3379,MAX_CUBE_MAP_TEXTURE_SIZE:34076,MAX_TEXTURE_IMAGE_UNITS:34930,MAX_VERTEX_TEXTURE_IMAGE_UNITS:35660,MAX_COMBINED_TEXTURE_IMAGE_UNITS:35661,MAX_VERTEX_ATTRIBS:34921,MAX_VERTEX_UNIFORM_VECTORS:36347,MAX_FRAGMENT_UNIFORM_VECTORS:36349,MAX_VARYING_VECTORS:36348,MAX_VIEWPORT_DIMS:3386,VERSION:7938,SHADING_LANGUAGE_VERSION:35724,VENDOR:7936,RENDERER:7937,VIEWPORT:2978,SCISSOR_BOX:3088,NO_ERROR:0,INVALID_ENUM:1280,INVALID_VALUE:1281,INVALID_OPERATION:1282,OUT_OF_MEMORY:1285};
export function createSoftwareGL(kit,state,changed,options={}){
 options ??= {};
 let resolveImage=options.resolveImage;
 let publicCanvas=options.canvas ? new WeakRef(options.canvas) : null;
 let error=0,program=null,array=null,index=null,attrs=new Map(),enabled=new Set(),depth=new Float32Array(state.width*state.height).fill(1),vp=[0,0,state.width,state.height],clear=[0,0,0,0],clearZ=1,writeDepth=true,depthFunc=GL.LESS,front=GL.CCW,cull=GL.BACK;
 // Like a graphics command buffer, defer raster work until the bitmap is read.
 // A full color+depth clear makes earlier unobserved draws redundant. Vertex
 // outputs and uniforms are captured at draw time, so later mutations are safe.
 let pending=[],pendingBytes=0,colorPixels=new Uint8Array(state.width*state.height*4),pixelsDirty=false;
 function flushPending(){const jobs=pending;pending=[];pendingBytes=0;for(const job of jobs)job();texture?.releaseRetired();if(pixelsDirty){state.raster.getCanvas().writePixels(colorPixels,state.width,state.height,0,0,kit.AlphaType.Unpremul,kit.ColorType.RGBA_8888,kit.ColorSpace.SRGB);pixelsDirty=false;}}
 const buffers=new WeakMap(),shaders=new WeakMap(),programs=new WeakMap(),locations=new WeakMap(),resources=new Set();
 const object=(tag,map,data)=>{const obj=Object.create(null);Object.defineProperty(obj,Symbol.toStringTag,{value:tag});map.set(obj,data);return obj;};
 const fail=code=>{error ||= code;};
 const getP=()=>programs.get(program);
 const fragments=new DrawCache();
 const texture=textureState(kit,()=>resolveImage,flushPending,fail);
 function allocateDepth(){if(depth.length!==state.width*state.height)depth=new Float32Array(state.width*state.height).fill(1);}
 const methods={
  getContextAttributes:()=>({alpha:true,depth:true,stencil:false,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true}),isContextLost:()=>!state.surface,
  getError:()=>{const e=error;error=0;return e;},getSupportedExtensions:()=>['OES_element_index_uint'],getExtension:name=>name==='OES_element_index_uint'?Object.create(null):null,
  getShaderPrecisionFormat:()=>({rangeMin:127,rangeMax:127,precision:23}),
  getParameter:p=>({[GL.VERSION]:'WebGL 1.0 (Buninu CPU)',[GL.SHADING_LANGUAGE_VERSION]:'WebGL GLSL ES 1.0',[GL.VENDOR]:'Buninu',[GL.RENDERER]:'CanvasKit CPU',[GL.MAX_TEXTURE_SIZE]:4096,[GL.MAX_CUBE_MAP_TEXTURE_SIZE]:4096,[GL.MAX_TEXTURE_IMAGE_UNITS]:8,[GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS]:0,[GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]:8,[GL.MAX_VERTEX_ATTRIBS]:8,[GL.MAX_VERTEX_UNIFORM_VECTORS]:256,[GL.MAX_FRAGMENT_UNIFORM_VECTORS]:256,[GL.MAX_VARYING_VECTORS]:8,[GL.MAX_VIEWPORT_DIMS]:new Int32Array([4096,4096]),[GL.VIEWPORT]:new Int32Array(vp),[GL.SCISSOR_BOX]:new Int32Array(vp),[0x846D]:new Float32Array([1,1]),[0x846E]:new Float32Array([1,1])}[p]??0),
  createBuffer:()=>object('WebGLBuffer',buffers,{data:new Uint8Array()}),bindBuffer:(target,b)=>{if(b&&!buffers.has(b)){fail(GL.INVALID_OPERATION);return;}if(target===GL.ARRAY_BUFFER)array=b;else if(target===GL.ELEMENT_ARRAY_BUFFER)index=b;else fail(GL.INVALID_ENUM);},
  bufferData:(target,data)=>{const b=buffers.get(target===GL.ARRAY_BUFFER?array:index);if(!b){fail(GL.INVALID_OPERATION);return;}const size=typeof data==='number'?data:data?.byteLength;if(!(size>=0&&size<=64*1024*1024)){fail(GL.INVALID_VALUE);return;}b.data=typeof data==='number'?new Uint8Array(data):new Uint8Array(data.buffer??data,data.byteOffset??0,size).slice();},
  bufferSubData:(target,offset,data)=>{const b=buffers.get(target===GL.ARRAY_BUFFER?array:index);if(!b||offset<0||offset+data.byteLength>b.data.length){fail(GL.INVALID_VALUE);return;}b.data.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);},deleteBuffer:b=>buffers.delete(b),
  createShader:type=>object('WebGLShader',shaders,{type,source:'',compiled:null,log:''}),shaderSource:(s,source)=>{const sh=shaders.get(s);if(sh)sh.source=String(source);else fail(GL.INVALID_OPERATION);},
  compileShader:s=>{const sh=shaders.get(s);if(!sh)return fail(GL.INVALID_OPERATION);try{if(sh.compiled){flushPending();resources.delete(sh.compiled.effect);sh.compiled.effect.delete();}sh.compiled=compileStage(kit,sh.source,sh.type===GL.VERTEX_SHADER?'vertex':'fragment');resources.add(sh.compiled.effect);sh.log='';}catch(e){sh.compiled=null;sh.log=e.message;}},
  getShaderParameter:(s,p)=>p===GL.COMPILE_STATUS?!!shaders.get(s)?.compiled:null,getShaderInfoLog:s=>shaders.get(s)?.log??'',getShaderSource:s=>shaders.get(s)?.source??'',deleteShader:()=>{},
  createProgram:()=>object('WebGLProgram',programs,{shaders:[],uniforms:[],attributes:[],values:new Map(),linked:false,log:''}),attachShader:(p,s)=>programs.get(p)?.shaders.push(s),
  linkProgram:p=>{const pr=programs.get(p);if(!pr)return;pr.vertex=pr.shaders.map(s=>shaders.get(s)).find(s=>s.type===GL.VERTEX_SHADER)?.compiled;pr.fragment=pr.shaders.map(s=>shaders.get(s)).find(s=>s.type===GL.FRAGMENT_SHADER)?.compiled;pr.linked=!!(pr.vertex&&pr.fragment);if(!pr.linked){pr.log='A shader failed to compile';return;}pr.uniforms=[...new Map([...pr.vertex.uniforms,...pr.fragment.uniforms].map(u=>[u.name,u])).values()];pr.attributes=pr.vertex.attributes;},
  getProgramParameter:(p,k)=>{const pr=programs.get(p);return k===GL.LINK_STATUS||k===GL.VALIDATE_STATUS?!!pr?.linked:k===GL.ACTIVE_UNIFORMS?pr?.uniforms.length:k===GL.ACTIVE_ATTRIBUTES?pr?.attributes.length:0;},getProgramInfoLog:p=>programs.get(p)?.log??'',validateProgram:()=>{},
  getActiveUniform:(p,i)=>{const u=programs.get(p)?.uniforms[i];return u?{name:u.name+(u.size>1?'[0]':''),size:u.size,type:glType(u.type)}:null;},
  getUniformLocation:(p,name)=>{const pr=programs.get(p),n=String(name).replace(/\[0\]$/,'');return pr?.uniforms.some(u=>u.name===n)?object('WebGLUniformLocation',locations,{pr,name:n}):null;},
  getActiveAttrib:(p,i)=>{const a=programs.get(p)?.attributes[i];return a?{name:a.name,size:1,type:glType(a.type)}:null;},getAttribLocation:(p,name)=>programs.get(p)?.attributes.findIndex(a=>a.name===name)??-1,
  useProgram:p=>{if(p&&!programs.get(p)?.linked)return fail(GL.INVALID_OPERATION);program=p;},deleteProgram:p=>programs.delete(p),
  enableVertexAttribArray:i=>{const a=attrs.get(i)||{};a.enabled=true;attrs.set(i,a);},disableVertexAttribArray:i=>{const a=attrs.get(i);if(a)a.enabled=false;},
  vertexAttribPointer:(i,size,type,normalized,stride,offset)=>{attrs.set(i,{...attrs.get(i),buffer:array,size,type,normalized,stride,offset});},
  enable:cap=>enabled.add(cap),disable:cap=>enabled.delete(cap),isEnabled:cap=>enabled.has(cap),depthFunc:v=>{depthFunc=v;},depthMask:v=>{writeDepth=!!v;},frontFace:v=>{front=v;},cullFace:v=>{cull=v;},
  viewport:(x,y,w,h)=>{vp=[x,y,w,h];},clearColor:(...c)=>{clear=c;},clearDepth:v=>{clearZ=v;},
  clear:mask=>{if((mask&(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT))===(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT)&&writeDepth&&!enabled.has(GL.SCISSOR_TEST)){pending=[];pendingBytes=0;}else flushPending();allocateDepth();if(mask&GL.COLOR_BUFFER_BIT){const rgba=Uint8Array.from(clear,v=>Math.round(Math.max(0,Math.min(1,v))*255)),word=new Uint32Array(rgba.buffer)[0];new Uint32Array(colorPixels.buffer).fill(word);pixelsDirty=true;changed(state);}if(mask&GL.DEPTH_BUFFER_BIT&&writeDepth)depth.fill(clearZ);},
  drawArrays:(mode,first,count)=>draw(mode,Array.from({length:count},(_,i)=>first+i)),
  drawElements:(mode,count,type,offset)=>{const b=buffers.get(index);if(!b)return fail(GL.INVALID_OPERATION);const bytes=type===GL.UNSIGNED_INT?4:type===GL.UNSIGNED_SHORT?2:1;if(offset<0||count<0||offset+count*bytes>b.data.length)return fail(GL.INVALID_OPERATION);const v=new DataView(b.data.buffer,b.data.byteOffset,b.data.byteLength);draw(mode,Array.from({length:count},(_,i)=>bytes===4?v.getUint32(offset+i*4,true):bytes===2?v.getUint16(offset+i*2,true):v.getUint8(offset+i)));},
  flush:()=>{flushPending();state.raster.flush();},finish:()=>{flushPending();state.raster.flush();},
 };
 // Fixed-function state that does not affect the initial opaque triangle subset.
 for(const name of ['clearStencil','colorMask','blendEquation','blendEquationSeparate','blendFunc','blendFuncSeparate','blendColor','stencilMask','stencilFunc','stencilOp','pixelStorei','scissor','polygonOffset','lineWidth','hint','activeTexture','bindTexture','texParameteri','texParameterf','texImage2D','texSubImage2D','generateMipmap','deleteTexture','bindFramebuffer','bindRenderbuffer','deleteFramebuffer','deleteRenderbuffer'])methods[name]=()=>{};
 Object.assign(methods,texture.methods);methods.checkFramebufferStatus=()=>GL.FRAMEBUFFER_COMPLETE;
 for(const n of [1,2,3,4])for(const suffix of ['f','i','fv','iv'])methods[`uniform${n}${suffix}`]=(loc,...v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||getP()!==l.pr)return fail(GL.INVALID_OPERATION);l.pr.values.set(l.name,suffix.endsWith('v')?Array.from(v[0]):n===1?v[0]:v);};
 for(const n of [2,3,4])methods[`uniformMatrix${n}fv`]=(loc,transpose,v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||transpose||getP()!==l.pr)return fail(GL.INVALID_OPERATION);l.pr.values.set(l.name,Array.from(v));};
 function draw(mode,indices){
  if(mode!==GL.TRIANGLES||indices.length>1000000)return fail(GL.INVALID_ENUM);const pr=getP();if(!pr?.linked)return fail(GL.INVALID_OPERATION);allocateDepth();
  const count=indices.reduce((m,i)=>Math.max(m,i),-1)+1;if(!count||count>1000000)return fail(GL.INVALID_VALUE);const inputs=new Map();
  for(let i=0;i<pr.attributes.length;i++){const spec=pr.attributes[i],a=attrs.get(i),b=buffers.get(a?.buffer);if(!a?.enabled||!b)continue;const bytes=a.type===GL.FLOAT?4:2,stride=a.stride||a.size*bytes;if(a.offset+(count-1)*stride+a.size*bytes>b.data.length)return fail(GL.INVALID_OPERATION);const view=new DataView(b.data.buffer,b.data.byteOffset,b.data.byteLength),data=new Float32Array(count*spec.size);for(let v=0;v<count;v++)for(let c=0;c<spec.size;c++)data[v*spec.size+c]=c<a.size?(a.type===GL.FLOAT?view.getFloat32(a.offset+v*stride+c*4,true):view.getInt16(a.offset+v*stride+c*2,true)):0;inputs.set(spec.name,data);}
  const saved={...pr,values:new Map(pr.values)},samplers=texture.capture(pr.fragment,pr.values),settings={vp:vp.slice(),enabled:new Set(enabled),depthFunc,writeDepth,front,cull};
  const reusable=!settings.enabled.has(GL.DEPTH_TEST)||(settings.writeDepth&&(settings.depthFunc===GL.LESS||settings.depthFunc===GL.LEQUAL));
  const key=reusable?fragments.key(saved,samplers,settings,[state.width,state.height],inputs,indices):null;
  pending.push(()=>{try{
    const cached=key&&fragments.get(key);
    if(cached){present(cached.pixels,cached.left,cached.top,cached.width,cached.height,null,cached.depth,settings.depthFunc);changed(state);return;}
    const verts=runVertices(kit,saved.vertex,saved.values,inputs,count);const clipped=clipTriangles(verts,indices,saved.vertex.outputCount);
    raster(saved,clipped.vertices,clipped.indices,settings,samplers,key);
   }catch(e){fail(GL.INVALID_OPERATION);console.error('CPU WebGL draw:',e.message);}});
  pendingBytes+=indices.length*4+[...inputs.values()].reduce((n,a)=>n+a.byteLength,0);
  changed(state);if(pendingBytes>32*1024*1024)flushPending();
 }
 function applyDepth(geometryDepth,left,top,width,height,func){
  if(!geometryDepth)return null;
  const visible=new Uint8Array(width*height*4);let count=0,occluded=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const i=y*width+x,z=geometryDepth[i];if(z===Infinity)continue;
   const pos=(y+top)*state.width+x+left;
   if(func===GL.LEQUAL?z<=depth[pos]:z<depth[pos]){visible[i*4+3]=255;depth[pos]=z;count++;}else occluded++;
  }
  return count?(occluded?visible:null):false;
 }
 // The canvas surface is unpremultiplied RGBA. Compose decoded fragments in
 // JS and upload once per flush instead of invoking Skia for every mesh/mask.
 function present(pixels,left,top,width,height,mask,geometryDepth=null,func=GL.LESS){
  const source=new Uint32Array(pixels.buffer,pixels.byteOffset,pixels.byteLength/4),target=new Uint32Array(colorPixels.buffer);
  for(let y=0;y<height;y++){let pos=(y+top)*state.width+left,i=y*width;for(let x=0;x<width;x++,pos++,i++){
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

 function raster(pr,verts,indices,{vp,enabled,depthFunc,writeDepth,front,cull},samplers,key){
  if(!indices.length)return;
  const width=state.width,height=state.height,n=pr.vertex.outputCount;
  const triangles=[];let left=width,top=height,right=-1,bottom=-1;
  const offsets=new Map();let off=4;for(const v of pr.vertex.varyings){offsets.set(v.name,off);off+=v.size;}
  let touched=false;
  for(let t=0;t+2<indices.length;t+=3){const ids=indices.slice(t,t+3),p=ids.map(i=>{const o=i*n,w=verts[o+3];return [vp[0]+(verts[o]/w+1)*vp[2]/2,height-vp[1]-(verts[o+1]/w+1)*vp[3]/2,verts[o+2]/w,1/w];});
   if(p.some(a=>!a.every(Number.isFinite)||a[3]<=0))continue;
   const area=(p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]);if(!area)continue;
   const facing=front===GL.CCW?area<0:area>0;if(enabled.has(GL.CULL_FACE)&&((cull===GL.BACK&&!facing)||(cull===GL.FRONT&&facing)||cull===GL.FRONT_AND_BACK))continue;
   const x0=Math.max(0,Math.floor(Math.min(...p.map(a=>a[0])))),x1=Math.min(width-1,Math.ceil(Math.max(...p.map(a=>a[0]))));const y0=Math.max(0,Math.floor(Math.min(...p.map(a=>a[1])))),y1=Math.min(height-1,Math.ceil(Math.max(...p.map(a=>a[1]))));
   if(x1<x0||y1<y0)continue;
   triangles.push({ids,p,area,facing,x0,x1,y0,y1});left=Math.min(left,x0);right=Math.max(right,x1);top=Math.min(top,y0);bottom=Math.max(bottom,y1);
  }
  if(!triangles.length)return;
  // Compact attribute images to the mesh bounds. Align to derivative quads
  // and keep a zero border for helper samples outside triangle coverage.
  left=Math.max(0,(left&~1)-2);top=Math.max(0,(top&~1)-2);right=Math.min(width-1,(right|1)+2);bottom=Math.min(height-1,(bottom|1)+2);
  const rw=right-left+1,rh=bottom-top+1;
  // Cache geometry shading independently of other draw calls' depth masks.
  // Moving a foreground object must not invalidate a static wall's lighting.
  const separateDepth=enabled.has(GL.DEPTH_TEST)&&writeDepth&&(depthFunc===GL.LESS||depthFunc===GL.LEQUAL);
  const geometryDepth=separateDepth?new Float32Array(rw*rh).fill(Infinity):null;
  const coverage=new Float32Array(rw*rh*4),varying=pr.fragment.varyings.map(v=>new Float32Array(rw*rh*4));
  for(const {ids,p,area,facing,x0,x1,y0,y1} of triangles){
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const px=x+.5,py=y+.5,b0=((p[1][0]-px)*(p[2][1]-py)-(p[1][1]-py)*(p[2][0]-px))/area,b1=((p[2][0]-px)*(p[0][1]-py)-(p[2][1]-py)*(p[0][0]-px))/area,b2=1-b0-b1;if(b0<0||b1<0||b2<0)continue;const z=Math.fround((b0*p[0][2]+b1*p[1][2]+b2*p[2][2])*.5+.5);if(z<0||z>1)continue;const pos=y*width+x;
    const local=(y-top)*rw+x-left;
    const oldDepth=separateDepth?geometryDepth[local]:depth[pos];
    if(enabled.has(GL.DEPTH_TEST)&&!(depthFunc===GL.ALWAYS||(depthFunc===GL.LEQUAL?z<=oldDepth:z<oldDepth)))continue;
    if(separateDepth)geometryDepth[local]=z;
    else if(enabled.has(GL.DEPTH_TEST)&&writeDepth)depth[pos]=z;
    touched=true;
    const pixel=((y-top)*rw+x-left)*4;
    coverage[pixel]=facing?1:-1;coverage[pixel+1]=height-py;coverage[pixel+2]=z;coverage[pixel+3]=1;
    // Avoid per-pixel arrays and reduce callbacks: large foreground meshes can
    // cover millions of samples in a single draw.
    const w=b0*p[0][3]+b1*p[1][3]+b2*p[2][3],w0=b0*p[0][3]/w,w1=b1*p[1][3]/w,w2=b2*p[2][3]/w;
    for(let k=0;k<pr.fragment.varyings.length;k++){const v=pr.fragment.varyings[k],o=offsets.get(v.name);if(o===undefined)continue;for(let c=0;c<v.size;c++)varying[k][pixel+c]=w0*verts[ids[0]*n+o+c]+w1*verts[ids[1]*n+o+c]+w2*verts[ids[2]*n+o+c];}
   }
  }
  if(!touched)return;
  const mask=applyDepth(geometryDepth,left,top,rw,rh,depthFunc);
  if(mask===false)return;
  const show=pixels=>{present(pixels,left,top,rw,rh,mask);fragments.put(key,pixels,left,top,rw,rh,geometryDepth);};
  if(pr.fragment.cpu){
   for(const t of samplers)pr.values.set('_sw_size_'+t.key,[t.width??1,t.height??1]);
   const pixels=runCPUFragment(pr.fragment,pr.values,samplers,coverage,varying,rw,rh,left,top,height);
   if(pixels){show(pixels);changed(state);return;}
  }
  const images=[],children=[];let effect,paint;
  try{for(const data of [coverage,...varying]){const img=floatImage(kit,rw,rh,data);images.push(img);children.push(imageShader(kit,img,[1,0,left,0,1,top,0,0,1]));}children.push(...texture.shaders(samplers,pr.values));effect=shader(kit,pr.fragment,pr.values,children);paint=new kit.Paint();paint.setShader(effect);paint.setBlendMode(kit.BlendMode.SrcOver);
   const surface=kit.MakeSurface(rw,rh);
   if(surface){let image;try{const canvas=surface.getCanvas();canvas.clear(kit.TRANSPARENT);canvas.translate(-left,-top);canvas.drawRect(kit.LTRBRect(left,top,right+1,bottom+1),paint);surface.flush();image=surface.makeImageSnapshot();const pixels=image.readPixels(0,0,{width:rw,height:rh,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB});if(!pixels)throw Error('Cannot read fragment surface');show(Uint8Array.from(pixels));}finally{image?.delete();surface.dispose();}}
   else throw Error('Cannot allocate fragment surface');
   changed(state);}finally{paint?.delete();effect?.delete();for(const c of children)c.delete();for(const i of images)i.delete();}
 }
 const proxy=Object.create(null);for(const [name,value] of Object.entries({...GL,...methods}))Object.defineProperty(proxy,name,{value,enumerable:true});Object.defineProperties(proxy,{canvas:{get:()=>publicCanvas?.deref()??null},drawingBufferWidth:{get:()=>state.width},drawingBufferHeight:{get:()=>state.height},[Symbol.toStringTag]:{value:'WebGLRenderingContext'}});
 return {proxy,flush:flushPending,dispose(){pending=[];pendingBytes=0;colorPixels=new Uint8Array();pixelsDirty=false;texture.dispose();fragments.clear();for(const r of resources)r.delete();resources.clear();},reset(){pending=[];pendingBytes=0;colorPixels=new Uint8Array(state.width*state.height*4);pixelsDirty=false;fragments.clear();depth=new Float32Array(state.width*state.height).fill(1);vp=[0,0,state.width,state.height];},configure:o=>{resolveImage=o.resolveImage;publicCanvas=o.canvas?new WeakRef(o.canvas):null;}};
}

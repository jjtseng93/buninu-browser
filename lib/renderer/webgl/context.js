import {clipTriangles} from './clip.js';
import {components,glType} from './shaders.js';
import {compileStage,runVertices,shader,floatImage,imageShader} from './pipeline.js';
const GL={DEPTH_BUFFER_BIT:256,STENCIL_BUFFER_BIT:1024,COLOR_BUFFER_BIT:16384,POINTS:0,LINES:1,LINE_LOOP:2,LINE_STRIP:3,TRIANGLES:4,TRIANGLE_STRIP:5,TRIANGLE_FAN:6,ZERO:0,ONE:1,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,FUNC_ADD:32774,NEVER:512,LESS:513,EQUAL:514,LEQUAL:515,GREATER:516,NOTEQUAL:517,GEQUAL:518,ALWAYS:519,FRONT:1028,BACK:1029,FRONT_AND_BACK:1032,CW:2304,CCW:2305,CULL_FACE:2884,BLEND:3042,DEPTH_TEST:2929,SCISSOR_TEST:3089,STENCIL_TEST:2960,POLYGON_OFFSET_FILL:32823,BYTE:5120,UNSIGNED_BYTE:5121,SHORT:5122,UNSIGNED_SHORT:5123,INT:5124,UNSIGNED_INT:5125,FLOAT:5126,ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,DYNAMIC_DRAW:35048,STREAM_DRAW:35040,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,LINK_STATUS:35714,VALIDATE_STATUS:35715,ACTIVE_UNIFORMS:35718,ACTIVE_ATTRIBUTES:35721,HIGH_FLOAT:36338,MEDIUM_FLOAT:36337,LOW_FLOAT:36336,HIGH_INT:36341,MEDIUM_INT:36340,LOW_INT:36339,FLOAT_VEC2:35664,FLOAT_VEC3:35665,FLOAT_VEC4:35666,FLOAT_MAT3:35675,FLOAT_MAT4:35676,SAMPLER_2D:35678,TEXTURE_2D:3553,TEXTURE_CUBE_MAP:34067,TEXTURE_CUBE_MAP_POSITIVE_X:34069,TEXTURE0:33984,RGBA:6408,RGB:6407,ALPHA:6406,NEAREST:9728,LINEAR:9729,NEAREST_MIPMAP_NEAREST:9984,LINEAR_MIPMAP_NEAREST:9985,NEAREST_MIPMAP_LINEAR:9986,LINEAR_MIPMAP_LINEAR:9987,CLAMP_TO_EDGE:33071,REPEAT:10497,MIRRORED_REPEAT:33648,TEXTURE_MAG_FILTER:10240,TEXTURE_MIN_FILTER:10241,TEXTURE_WRAP_S:10242,TEXTURE_WRAP_T:10243,UNPACK_FLIP_Y_WEBGL:37440,UNPACK_PREMULTIPLY_ALPHA_WEBGL:37441,UNPACK_ALIGNMENT:3317,PACK_ALIGNMENT:3333,FRAMEBUFFER:36160,RENDERBUFFER:36161,FRAMEBUFFER_COMPLETE:36053,MAX_TEXTURE_SIZE:3379,MAX_CUBE_MAP_TEXTURE_SIZE:34076,MAX_TEXTURE_IMAGE_UNITS:34930,MAX_VERTEX_TEXTURE_IMAGE_UNITS:35660,MAX_COMBINED_TEXTURE_IMAGE_UNITS:35661,MAX_VERTEX_ATTRIBS:34921,MAX_VERTEX_UNIFORM_VECTORS:36347,MAX_FRAGMENT_UNIFORM_VECTORS:36349,MAX_VARYING_VECTORS:36348,MAX_VIEWPORT_DIMS:3386,VERSION:7938,SHADING_LANGUAGE_VERSION:35724,VENDOR:7936,RENDERER:7937,VIEWPORT:2978,SCISSOR_BOX:3088,NO_ERROR:0,INVALID_ENUM:1280,INVALID_VALUE:1281,INVALID_OPERATION:1282,OUT_OF_MEMORY:1285};
export function createSoftwareGL(kit,state,changed,options={}){
 options ??= {};
 let publicCanvas=options.canvas ? new WeakRef(options.canvas) : null;
 let error=0,program=null,array=null,index=null,attrs=new Map(),enabled=new Set(),depth=new Float32Array(state.width*state.height).fill(1),vp=[0,0,state.width,state.height],clear=[0,0,0,0],clearZ=1,writeDepth=true,depthFunc=GL.LESS,front=GL.CCW,cull=GL.BACK;
 const buffers=new WeakMap(),shaders=new WeakMap(),programs=new WeakMap(),locations=new WeakMap(),resources=new Set();
 const object=(tag,map,data)=>{const obj=Object.create(null);Object.defineProperty(obj,Symbol.toStringTag,{value:tag});map.set(obj,data);return obj;};
 const fail=code=>{error ||= code;};
 const getP=()=>programs.get(program);
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
  compileShader:s=>{const sh=shaders.get(s);if(!sh)return fail(GL.INVALID_OPERATION);try{if(sh.compiled){resources.delete(sh.compiled.effect);sh.compiled.effect.delete();}sh.compiled=compileStage(kit,sh.source,sh.type===GL.VERTEX_SHADER?'vertex':'fragment');resources.add(sh.compiled.effect);sh.log='';}catch(e){sh.compiled=null;sh.log=e.message;}},
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
  clear:mask=>{allocateDepth();if(mask&GL.COLOR_BUFFER_BIT){state.raster.getCanvas().clear(kit.Color4f(...clear));changed(state);}if(mask&GL.DEPTH_BUFFER_BIT&&writeDepth)depth.fill(clearZ);},
  drawArrays:(mode,first,count)=>draw(mode,Array.from({length:count},(_,i)=>first+i)),
  drawElements:(mode,count,type,offset)=>{const b=buffers.get(index);if(!b)return fail(GL.INVALID_OPERATION);const bytes=type===GL.UNSIGNED_INT?4:type===GL.UNSIGNED_SHORT?2:1;if(offset<0||count<0||offset+count*bytes>b.data.length)return fail(GL.INVALID_OPERATION);const v=new DataView(b.data.buffer,b.data.byteOffset,b.data.byteLength);draw(mode,Array.from({length:count},(_,i)=>bytes===4?v.getUint32(offset+i*4,true):bytes===2?v.getUint16(offset+i*2,true):v.getUint8(offset+i)));},
  flush:()=>state.raster.flush(),finish:()=>state.raster.flush(),
 };
 // Fixed-function state that does not affect the initial opaque triangle subset.
 for(const name of ['clearStencil','colorMask','blendEquation','blendEquationSeparate','blendFunc','blendFuncSeparate','blendColor','stencilMask','stencilFunc','stencilOp','pixelStorei','scissor','polygonOffset','lineWidth','hint','activeTexture','bindTexture','texParameteri','texParameterf','texImage2D','texSubImage2D','generateMipmap','deleteTexture','bindFramebuffer','bindRenderbuffer','deleteFramebuffer','deleteRenderbuffer'])methods[name]=()=>{};
 methods.createTexture=()=>Object.create(null);methods.checkFramebufferStatus=()=>GL.FRAMEBUFFER_COMPLETE;
 for(const n of [1,2,3,4])for(const suffix of ['f','i','fv','iv'])methods[`uniform${n}${suffix}`]=(loc,...v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||getP()!==l.pr)return fail(GL.INVALID_OPERATION);l.pr.values.set(l.name,suffix.endsWith('v')?Array.from(v[0]):n===1?v[0]:v);};
 for(const n of [2,3,4])methods[`uniformMatrix${n}fv`]=(loc,transpose,v)=>{if(loc===null)return;const l=locations.get(loc);if(!l||transpose||getP()!==l.pr)return fail(GL.INVALID_OPERATION);l.pr.values.set(l.name,Array.from(v));};
 function draw(mode,indices){
  if(mode!==GL.TRIANGLES||indices.length>1000000)return fail(GL.INVALID_ENUM);const pr=getP();if(!pr?.linked)return fail(GL.INVALID_OPERATION);allocateDepth();
  const count=indices.reduce((m,i)=>Math.max(m,i),-1)+1;if(!count||count>1000000)return fail(GL.INVALID_VALUE);const inputs=new Map();
  for(let i=0;i<pr.attributes.length;i++){const spec=pr.attributes[i],a=attrs.get(i),b=buffers.get(a?.buffer);if(!a?.enabled||!b)continue;const bytes=a.type===GL.FLOAT?4:2,stride=a.stride||a.size*bytes;if(a.offset+(count-1)*stride+a.size*bytes>b.data.length)return fail(GL.INVALID_OPERATION);const view=new DataView(b.data.buffer,b.data.byteOffset,b.data.byteLength),data=new Float32Array(count*spec.size);for(let v=0;v<count;v++)for(let c=0;c<spec.size;c++)data[v*spec.size+c]=c<a.size?(a.type===GL.FLOAT?view.getFloat32(a.offset+v*stride+c*4,true):view.getInt16(a.offset+v*stride+c*2,true)):0;inputs.set(spec.name,data);}
  try{const verts=runVertices(kit,pr.vertex,pr.values,inputs,count);const clipped=clipTriangles(verts,indices,pr.vertex.outputCount);raster(pr,clipped.vertices,clipped.indices);}catch(e){fail(GL.INVALID_OPERATION);console.error('CPU WebGL draw:',e.message);}
 }
 function raster(pr,verts,indices){
  const width=state.width,height=state.height,n=pr.vertex.outputCount;
  const coverage=new Float32Array(width*height*4),varying=pr.fragment.varyings.map(v=>new Float32Array(width*height*4));
  const offsets=new Map();let off=4;for(const v of pr.vertex.varyings){offsets.set(v.name,off);off+=v.size;}
  let touched=false;
  for(let t=0;t+2<indices.length;t+=3){const ids=indices.slice(t,t+3),p=ids.map(i=>{const o=i*n,w=verts[o+3];return [vp[0]+(verts[o]/w+1)*vp[2]/2,height-vp[1]-(verts[o+1]/w+1)*vp[3]/2,verts[o+2]/w,1/w];});
   if(p.some(a=>!a.every(Number.isFinite)||a[3]<=0))continue;
   const area=(p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]);if(!area)continue;
   const facing=front===GL.CCW?area<0:area>0;if(enabled.has(GL.CULL_FACE)&&((cull===GL.BACK&&!facing)||(cull===GL.FRONT&&facing)||cull===GL.FRONT_AND_BACK))continue;
   const x0=Math.max(0,Math.floor(Math.min(...p.map(a=>a[0])))),x1=Math.min(width-1,Math.ceil(Math.max(...p.map(a=>a[0]))));const y0=Math.max(0,Math.floor(Math.min(...p.map(a=>a[1])))),y1=Math.min(height-1,Math.ceil(Math.max(...p.map(a=>a[1]))));
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const px=x+.5,py=y+.5,b0=((p[1][0]-px)*(p[2][1]-py)-(p[1][1]-py)*(p[2][0]-px))/area,b1=((p[2][0]-px)*(p[0][1]-py)-(p[2][1]-py)*(p[0][0]-px))/area,b2=1-b0-b1;if(b0<0||b1<0||b2<0)continue;const z=(b0*p[0][2]+b1*p[1][2]+b2*p[2][2])*.5+.5;if(z<0||z>1)continue;const pos=y*width+x;
    if(enabled.has(GL.DEPTH_TEST)&&!(depthFunc===GL.ALWAYS||(depthFunc===GL.LEQUAL?z<=depth[pos]:z<depth[pos])))continue;
    if(enabled.has(GL.DEPTH_TEST)&&writeDepth)depth[pos]=z;
    touched=true;coverage.set([facing?1:-1,height-py,z,1],pos*4);const w=b0*p[0][3]+b1*p[1][3]+b2*p[2][3],weights=[b0*p[0][3]/w,b1*p[1][3]/w,b2*p[2][3]/w];
    for(let k=0;k<pr.fragment.varyings.length;k++){const v=pr.fragment.varyings[k],o=offsets.get(v.name);if(o===undefined)continue;for(let c=0;c<v.size;c++)varying[k][pos*4+c]=weights.reduce((sum,w,i)=>sum+w*verts[ids[i]*n+o+c],0);}
   }
  }
  if(!touched)return;
  const images=[],children=[];let effect,paint;
  try{for(const data of [coverage,...varying]){const img=floatImage(kit,width,height,data);images.push(img);children.push(imageShader(kit,img));}effect=shader(kit,pr.fragment,pr.values,children);paint=new kit.Paint();paint.setShader(effect);paint.setBlendMode(kit.BlendMode.SrcOver);state.raster.getCanvas().drawPaint(paint);changed(state);}finally{paint?.delete();effect?.delete();for(const c of children)c.delete();for(const i of images)i.delete();}
 }
 const proxy=Object.create(null);for(const [name,value] of Object.entries({...GL,...methods}))Object.defineProperty(proxy,name,{value,enumerable:true});Object.defineProperties(proxy,{canvas:{get:()=>publicCanvas?.deref()??null},drawingBufferWidth:{get:()=>state.width},drawingBufferHeight:{get:()=>state.height},[Symbol.toStringTag]:{value:'WebGLRenderingContext'}});
 return {proxy,dispose(){for(const r of resources)r.delete();resources.clear();},reset(){depth=new Float32Array(state.width*state.height).fill(1);vp=[0,0,state.width,state.height];},configure:o=>{publicCanvas=o.canvas?new WeakRef(o.canvas):null;}};
}

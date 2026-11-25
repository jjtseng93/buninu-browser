// CPU texture storage. Images are copied at upload, not sampled from mutable DOM.
export function textureState(kit,resolveImage,flush,fail,webgl2=false){
 const textures=new WeakMap(),owned=new Set(),units=new Map(),retired=[];let unit=0,flip=false,alignment=4,version=0;
 const cubeFace=target=>target>=34069&&target<=34074;
 const bindingTarget=target=>cubeFace(target)?34067:target;
 const current=target=>textures.get(units.get(unit+':'+bindingTarget(target)));
 const key=(target,level)=>target+':'+level;
 const targetOK=target=>target===3553||target===34067||(webgl2&&(target===32879||target===35866));
 const channelCounts={6403:1,6406:1,6407:3,6408:4,33319:2,6402:1};
 const componentSizes={5121:1,5123:2,5131:2,5125:4,5126:4};
 function storeVolume(target,level,internal,width,height,depth,border,format,type,input,offset=0){
  if(target!==32879&&target!==35866)return fail(1280);
  const tex=current(target);if(!tex||tex.immutable)return fail(1282);
  if(level<0||border||![width,height,depth].every(n=>Number.isInteger(n)&&n>0&&n<=4096))return fail(1281);
  const columns=Math.min(depth,Math.max(1,Math.min(Math.floor(4096/width),Math.ceil(Math.sqrt(depth*height/width)))));
  const w=columns*width,h=Math.ceil(depth/columns)*height,float=type!==5121;
  if(h>16384||w*h*4*(float?4:1)>128*1024*1024)return fail(1285);
  const volume={width:w,height:h,volumeWidth:width,volumeHeight:height,depth,columns,internal,format,type,pixels:float?new Float32Array(w*h*4):new Uint8Array(w*h*4)};
  if(!input)install(tex,target,level,volume);
  else updateVolume(tex,target,level,volume,0,0,0,width,height,depth,format,type,input,offset);
 }
 function updateVolume(tex,target,level,old,x,y,z,w,h,d,format,type,input,offset){
  if(x<0||y<0||z<0||w<0||h<0||d<0||x+w>old.volumeWidth||y+h>old.volumeHeight||z+d>old.depth)return fail(1281);
  const bytes=componentSizes[type],channels=channelCounts[format];
  if(!bytes||!channels)return fail(1280);
  const pixels=old.pixels.slice(),pitch=Math.ceil(w*channels*bytes/alignment)*alignment;
  for(let i=0;i<d;i++){
   const src=unpack(w,h,format,type,input,offset+i*pitch*h/bytes);
   if(!src)return;
   const xx=(z+i)%old.columns*old.volumeWidth+x, yy=Math.floor((z+i)/old.columns)*old.volumeHeight+y;
   for(let row=0;row<h;row++)pixels.set(src.subarray(row*w*4,(row+1)*w*4),((yy+row)*old.width+xx)*4);
  }
  install(tex,target,level,{...old,pixels});
 }
 function subVolume(target,level,x,y,z,w,h,d,format,type,input,offset=0){
  const tex=current(target),old=tex?.levels.get(key(target,level));if(!old)return fail(1282);
  updateVolume(tex,target,level,old,x,y,z,w,h,d,format,type,input,offset);
 }
 function texStorage3D(target,levels,internal,w,h,d){
  const tex=current(target);
  if(!tex||tex.immutable)return fail(1282);
  if(levels<1||levels>Math.floor(Math.log2(Math.max(w,h,target===32879?d:1)))+1)return fail(1281);
  const type=[0x8814,0x881a,0x822e,0x8230].includes(internal)?5126:5121;
  for(let level=0;level<levels;level++){
   storeVolume(target,level,internal,w,h,d,0,6408,type,null);
   w=Math.max(1,w>>1);h=Math.max(1,h>>1);if(target===32879)d=Math.max(1,d>>1);
  }
  tex.immutable=true;
 }
 function unpack(width,height,format,type,input,offset=0){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096){fail(1281);return;}
  const channels=channelCounts[format];
  const component=componentSizes[type];
  if(!component||!channels){fail(1280);return;}
  const floating=type!==5121,ArrayType=floating?Float32Array:Uint8Array;
  if(!input)return new ArrayType(width*height*4);
  if(!ArrayBuffer.isView(input)||offset<0||offset*component>input.byteLength){fail(1282);return;}
  const row=width*channels*component,pitch=Math.ceil(row/alignment)*alignment;
  const start=input.byteOffset+offset*component,length=input.byteLength-offset*component;
  if(length<(height-1)*pitch+row){fail(1282);return;}
  if(type===5121&&channels===4&&!flip)return new Uint8Array(input.buffer,start,width*height*4).slice();
  const out=new ArrayType(width*height*4);
  const view=new DataView(input.buffer,start,length);
  const read=type===5121?pos=>view.getUint8(pos):type===5126?pos=>view.getFloat32(pos,true):type===5131?pos=>view.getFloat16(pos,true):
   type===5123?pos=>view.getUint16(pos,true)/65535:pos=>view.getUint32(pos,true)/4294967295;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const dest=((flip?height-1-y:y)*width+x)*4,src=y*pitch+x*channels*component;
   out[dest+3]=floating?1:255;
   for(let c=0;c<channels;c++)out[dest+(format===6406?3:c)]=read(src+c*component);
  }
  return out;
 }
 function fromElement(element){
  const src=resolveImage()?.(element);
  if(!src?.image){fail(1281);return;}
  if(src.originClean===false)throw new DOMException('Cross-origin texture','SecurityError');
  const {width,height}=src;
  const pixels=src.image.readPixels(0,0,{width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
  if(!pixels){fail(1282);return;}
  return {width,height,pixels:unpack(width,height,6408,5121,pixels)};
 }
 function install(tex,target,level,storage){
  const old=tex.levels.get(key(target,level));
  if(old?.image)retired.push(old.image);
  if(retired.length>32)flush();
  storage.version=++version;
  storage.image=null;
  tex.levels.set(key(target,level),storage);
  if(!cubeFace(target)&&level===0)Object.assign(tex,storage);
 }
 // Framebuffer-to-framebuffer operations already use the render storage.
 // Materialize a sampled snapshot only when the texture is actually read.
 function resolveRendered(tex,target,level){
  const storage=tex?.levels.get(key(target,level));
  if(!storage)return;
  if(!storage.rendered){
   if(!storage.pixels)install(tex,target,level,Object.assign(storage,{pixels:unpack(storage.width,storage.height,storage.format,storage.type,null)}));
   return storage;
  }
  const depth=storage.rendered==='depth';
  const source=depth?storage.depthPixels:storage.renderPixels;
  const {width,height}=storage, pixels=new source.constructor(width*height*4);
  for(let y=0;y<height;y++){
   const row=(height-1-y)*width;
   if(depth){
    for(let x=0;x<width;x++){const i=(y*width+x)*4;pixels[i]=source[row+x];pixels[i+3]=1;}
   }else pixels.set(source.subarray(row*4,(row+width)*4),y*width*4);
  }
  install(tex,target,level,Object.assign(storage,{pixels,rendered:null}));
  return storage;
 }
 function upload(...args){
  const [target,level,internal]=args;
  if(target!==3553&&!cubeFace(target))return fail(1280);
  if(level<0)return fail(1281);
  const tex=current(target);if(!tex||tex.immutable)return fail(1282);
  let source,format,type;
  if(args.length===6){format=args[3];type=args[4];source=fromElement(args[5]);}
  else{
   const width=args[3],height=args[4];format=args[6];type=args[7];
   if(args[8]===null&&componentSizes[type]&&channelCounts[format]&&Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=4096&&height<=4096){
    // Storage allocated with null is zero-initialized. The first render can
    // write directly to its framebuffer without building a zero sampler image.
    install(tex,target,level,{width,height,internal,format,type,pixels:null});
    return;
   }
   source={width,height,pixels:unpack(width,height,format,type,args[8],args[9])};
  }
  if(source?.pixels)install(tex,target,level,{...source,internal,format,type});
 }
 function subImage(target,level,x,y,...data){
  const tex=current(target),old=resolveRendered(tex,target,level);
  if(!old)return fail(1282);
  let src;
  if(data.length===3)src=fromElement(data[2]);
  else{
   const [width,height,format,type,source,offset]=data;
   if(x<0||y<0||x+width>old.width||y+height>old.height)return fail(1281);
   src={width,height,pixels:unpack(width,height,format,type,source,offset)};
  }
  if(!src?.pixels)return;
  if(x<0||y<0||x+src.width>old.width||y+src.height>old.height)return fail(1281);
  const pixels=old.pixels.slice(),scale=pixels.BYTES_PER_ELEMENT===src.pixels.BYTES_PER_ELEMENT?1:pixels instanceof Float32Array?1/255:255;
  for(let row=0;row<src.height;row++){
   const d=((row+y)*old.width+x)*4,s=row*src.width*4;
   if(scale===1)pixels.set(src.pixels.subarray(s,s+src.width*4),d);
   else for(let i=0;i<src.width*4;i++)pixels[d+i]=src.pixels[s+i]*scale;
  }
  install(tex,target,level,{...old,pixels,renderPixels:null,depthPixels:null});
 }
 function texStorage2D(target,levels,internal,w,h){
  if(levels<1||w<1||h<1||levels>Math.floor(Math.log2(Math.max(w,h)))+1)return fail(1281);
  const tex=current(target);if(!tex||tex.immutable)return fail(1282);
  for(let level=0;level<levels;level++){
   for(const face of target===34067?[34069,34070,34071,34072,34073,34074]:[target])
    upload(face,level,internal,w,h,0,6408,[0x8814,0x881a].includes(internal)?5126:5121,null);
   w=Math.max(1,w>>1);h=Math.max(1,h>>1);
  }
  tex.immutable=true;
 }
 return {
  level:(handle,face,level)=>textures.get(handle)?.levels.get(key(face,level)),
  markRendered(ref,storage,depth=false){
   if(ref?.texture)storage.rendered=depth?'depth':'color';
  },
  methods:{...(webgl2?{texImage3D:storeVolume,texStorage3D,texSubImage3D:subVolume,texStorage2D}:{}),createTexture(){const obj=Object.create(null),t={levels:new Map(),width:1,height:1,image:null,wrapS:10497,wrapT:10497,wrapR:10497,mag:9729,min:9986};textures.set(obj,t);owned.add(t);return obj;},
   activeTexture(value){if(value<33984||value>=33984+(webgl2?32:8)){fail(1280);return;}unit=value-33984;},
   bindTexture(target,obj){if(!targetOK(target))return fail(1280);const tex=textures.get(obj);
    if(obj&&(!tex||tex.target&&tex.target!==target))return fail(1282);
    if(tex)tex.target=target;units.set(unit+':'+target,obj);},
   texParameteri(target,key,value){const t=current(target);if(!t)return;const field={10240:'mag',10241:'min',10242:'wrapS',10243:'wrapT',32882:'wrapR'}[key];if(field)t[field]=value;},
   pixelStorei(key,value){if(key===37440)flip=!!value;else if(key===3317&&[1,2,4,8].includes(value))alignment=value;},
   texImage2D:upload,texSubImage2D:subImage,generateMipmap(){},deleteTexture(obj){const t=textures.get(obj);if(t){flush();for(const storage of t.levels.values())storage.image?.delete();owned.delete(t);textures.delete(obj);}},
  },
  capture(compiled,values,attachedToDraw){return compiled.uniforms.filter(u=>u.elements).sort((a,b)=>Number(a.type!=='sampler2D')-Number(b.type!=='sampler2D')).flatMap(u=>u.elements.map((key,i)=>{
    const value=values.get(u.name);
    const unit=typeof value==='number'&&i===0?value:value?.[i]??0;
    const target=u.type==='sampler3D'?32879:u.type==='sampler2DArray'?35866:3553;
    const handle=units.get(unit+':'+target),tex=textures.get(handle);
    const level=tex?.levels.get(target+':0');
    // Changing the draw framebuffer or an attachment drains pending draws.
    // Uploads replace the level. Until then a different framebuffer's
    // render storage can be sampled directly, including its scalar depth.
    if(webgl2&&level?.rendered&&(compiled.cpu||compiled.cpuVertex)&&!attachedToDraw(handle)){
     const depth=level.rendered==='depth';
     return {key,width:level.width,height:level.height,mag:tex.mag,wrapS:tex.wrapS,wrapT:tex.wrapT,
      topDown:true,depthPlane:depth,pixels:depth?level.depthPixels:level.renderPixels};
    }
    const storage=resolveRendered(tex,target,0);
    // Numeric shaders sample the immutable JS pixels directly. Upload the
    // same version to CanvasKit only for a program that uses an image shader.
    if(storage?.pixels&&!storage.image&&!compiled.cpu&&!compiled.cpuVertex){
     const {width,height,pixels}=storage;
     const colorType=pixels instanceof Float32Array?kit.ColorType.RGBA_F32:kit.ColorType.RGBA_8888;
     const info={width,height,colorType,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB};
     const bytes=new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength);
     tex.image=storage.image=kit.MakeImage(info,bytes,width*4*pixels.BYTES_PER_ELEMENT);
    }
    return {key,...tex,volume:target!==3553};
   }));},
  setUniforms(captured,values){for(const t of captured){values.set('_sw_size_'+t.key,[t.width??1,t.height??1]);
    if(t.volume){
     const mode=n=>n===10497?1:n===33648?2:0;
     values.set('_sw_dim_'+t.key,[t.volumeWidth??1,t.volumeHeight??1,t.depth??1,t.columns??1]);
     values.set('_sw_wrap_'+t.key,[mode(t.wrapS),mode(t.wrapT),mode(t.wrapR),Number(t.mag!==9728)]);
    }
   }},
  shaders(captured){const out=[];for(const t of captured){
    const tile=n=>n===10497?kit.TileMode.Repeat:n===33648?kit.TileMode.Mirror:kit.TileMode.Clamp;
    out.push(t.image?t.image.makeShaderOptions(tile(t.wrapS),tile(t.wrapT),t.volume||t.mag===9728?kit.FilterMode.Nearest:kit.FilterMode.Linear,kit.MipmapMode.None):kit.Shader.MakeColor(kit.Color(0,0,0,1),kit.ColorSpace.SRGB));}
   return out;},
  releaseRetired(){for(const img of retired)img.delete();retired.length=0;},
  dispose(){for(const img of retired)img.delete();retired.length=0;for(const t of owned)for(const storage of t.levels.values())storage.image?.delete();owned.clear();units.clear();},
 };
}

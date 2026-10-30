// CPU texture storage. Images are copied at upload, not sampled from mutable DOM.
export function textureState(kit,resolveImage,flush,fail){
 const textures=new WeakMap(),owned=new Set(),units=new Map(),retired=[];let unit=0,flip=false,alignment=4,version=0;
 const current=()=>textures.get(units.get(unit));
 function upload(...args){
  const [target,level,internal]=args;if(target!==3553||level!==0)return;
  const tex=current();if(!tex){fail(1282);return;}
  let width,height,bytes,format,type;
  if(args.length===6){const src=resolveImage()?.(args[5]);format=args[3];type=args[4];
   if(!src?.image){fail(1281);return;}if(src.originClean===false)throw new DOMException('Cross-origin texture','SecurityError');
   width=src.width;height=src.height;bytes=src.image.readPixels(0,0,{width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
  }else{width=args[3];height=args[4];format=args[6];type=args[7];const input=args[8];
   if(!(width>0&&height>0&&width<=4096&&height<=4096)){fail(1281);return;}
   if(type!==5121){fail(1280);return;}const count=format===6408?4:format===6407?3:format===6406?1:0;if(!count){fail(1280);return;}
   bytes=new Uint8Array(width*height*4);const stride=Math.ceil(width*count/alignment)*alignment;
   if(input&&input.byteLength<(height-1)*stride+width*count){fail(1282);return;}
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,j=y*stride+x*count;
    if(input){if(count===1)bytes[i+3]=input[j];else{bytes[i]=input[j];bytes[i+1]=input[j+1];bytes[i+2]=input[j+2];bytes[i+3]=count===4?input[j+3]:255;}}}
  }
  if(!bytes){fail(1282);return;}
  // CanvasKit readPixels may expose its WASM heap; textures own a stable copy.
  bytes=Uint8Array.from(bytes);
  if(flip){const row=width*4,copy=new Uint8Array(bytes.length);for(let y=0;y<height;y++)copy.set(bytes.subarray(y*row,(y+1)*row),(height-y-1)*row);bytes=copy;}
  if(tex.image)retired.push(tex.image);if(retired.length>32)flush();tex.width=width;tex.height=height;tex.pixels=bytes;tex.version=++version;
  tex.image=kit.MakeImage({width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB},bytes,width*4);
 }
 return {
  methods:{createTexture(){const obj=Object.create(null),t={width:1,height:1,image:null,wrapS:10497,wrapT:10497,mag:9729,min:9986};textures.set(obj,t);owned.add(t);return obj;},
   activeTexture(value){if(value<33984||value>=33992){fail(1280);return;}unit=value-33984;},
   bindTexture(target,obj){if(target!==3553)return;if(obj&&!textures.has(obj)){fail(1282);return;}units.set(unit,obj);},
   texParameteri(target,key,value){const t=current();if(!t)return;const field={10240:'mag',10241:'min',10242:'wrapS',10243:'wrapT'}[key];if(field)t[field]=value;},
   pixelStorei(key,value){if(key===37440)flip=!!value;else if(key===3317&&[1,2,4,8].includes(value))alignment=value;},
   texImage2D:upload,generateMipmap(){},deleteTexture(obj){const t=textures.get(obj);if(t){flush();t.image?.delete();owned.delete(t);textures.delete(obj);}},
  },
  capture(compiled,values){return compiled.uniforms.filter(u=>u.type==='sampler2D').map(u=>({key:u.key,...textures.get(units.get(Number(values.get(u.name)??0)))}));},
  shaders(captured,values){const out=[];for(const t of captured){values.set('_sw_size_'+t.key,[t.width??1,t.height??1]);
    const tile=n=>n===10497?kit.TileMode.Repeat:n===33648?kit.TileMode.Mirror:kit.TileMode.Clamp;
    out.push(t.image?t.image.makeShaderOptions(tile(t.wrapS),tile(t.wrapT),t.mag===9728?kit.FilterMode.Nearest:kit.FilterMode.Linear,kit.MipmapMode.None):kit.Shader.MakeColor(kit.Color(0,0,0,1),kit.ColorSpace.SRGB));}
   return out;},
  releaseRetired(){for(const img of retired)img.delete();retired.length=0;},
  dispose(){for(const img of retired)img.delete();retired.length=0;for(const t of owned)t.image?.delete();owned.clear();units.clear();},
 };
}

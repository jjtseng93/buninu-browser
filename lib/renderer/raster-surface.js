const rasterSurfaces = new WeakMap();

/** Skia's fast software blending uses premultiplied pixels internally.
 * Readback/export still explicitly requests ordinary unpremultiplied RGBA.
 * Keep the allocation tied to its own CanvasKit instance, including finalizers.
 */
export function makeRasterSurface(kit,width,height) {
  const memory=kit.Malloc(Uint8Array,width*height*4);
  let surface;
  try {
    surface=kit.MakeRasterDirectSurface({width,height,
      colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Premul,
      colorSpace:kit.ColorSpace.SRGB},memory,width*4);
    if(!surface){kit.Free(memory);return null;}
    surface.getCanvas().clear(kit.TRANSPARENT);
    rasterSurfaces.set(surface,{kit,memory,width,height});
    let disposed=false;
    surface.dispose=()=>{
      if(disposed)return;
      disposed=true;rasterSurfaces.delete(surface);
      try {surface.delete();} finally {kit.Free(memory);}
    };
    return surface;
  } catch(error) {surface?.delete();kit.Free(memory);throw error;}
}

/** Copy known RGBA/SRGB raster storage without Skia's alpha conversion.
 * Premultiplied and straight RGB are identical only when every copied alpha
 * is 255. Unknown surfaces and translucent straight-alpha output keep using
 * readPixels. Never retain a WASM heap view: growth replaces its buffer.
 */
export function copyRasterSurfacePixels(surface,target,{x=0,y=0,width,height,
  offset=0,stride=width*4,premultiplied=false}={}) {
  const owned=rasterSurfaces.get(surface);
  if(!owned||!(target instanceof Uint8Array))return false;
  if(![x,y,width,height,offset,stride].every(Number.isSafeInteger)
    ||x<0||y<0||width<1||height<1||offset<0||stride<width*4
    ||x+width>owned.width||y+height>owned.height
    ||offset+(height-1)*stride+width*4>target.length)return false;
  const {kit,memory}=owned;
  const sourceStride=owned.width*4,bytes=owned.width*owned.height*4;
  const start=memory.byteOffset;
  if(!Number.isSafeInteger(start)||start<0||start+bytes>kit.HEAPU8.byteLength)return false;
  const source=new Uint8Array(kit.HEAPU8.buffer,start,bytes);
  // Callers provide an owned destination; allowing a view onto this heap
  // could change the surface or alias rows that have not been copied yet.
  if(target.buffer===source.buffer)return false;
  if(!premultiplied)for(let row=0;row<height;row++){
    const begin=(y+row)*sourceStride+x*4,end=begin+width*4;
    for(let index=begin+3;index<end;index+=4)if(source[index]!==255)return false;
  }
  for(let row=0;row<height;row++){
    const begin=(y+row)*sourceStride+x*4;
    target.set(source.subarray(begin,begin+width*4),offset+row*stride);
  }
  return true;
}

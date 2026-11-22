const rasterSurfaces = new WeakMap();
const alphaMask = new Uint32Array(Uint8Array.of(0, 0, 0, 255).buffer)[0] | 0;

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
  const source = rasterPixels(owned,x,y,width,height,premultiplied);
  if (!source || target.buffer === source.buffer) return false;
  const sourceStride=owned.width*4;
  if(width===owned.width && stride===sourceStride){
    target.set(source.subarray(y*sourceStride,(y+height)*sourceStride),offset);
    return true;
  }
  for(let row=0;row<height;row++){
    const begin=(y+row)*sourceStride+x*4;
    target.set(source.subarray(begin,begin+width*4),offset+row*stride);
  }
  return true;
}

// Borrowed for synchronous read-only work after flush. A subsequent draw or
// WASM allocation can invalidate this view; never retain it across either.
export function opaqueRasterRegion(surface, {x,y,width,height}) {
  const owned=rasterSurfaces.get(surface);
  if (!owned || ![x,y,width,height].every(Number.isSafeInteger) || x<0 || y<0 ||
      width<1 || height<1 || x+width>owned.width || y+height>owned.height) return null;
  const bytes=rasterPixels(owned,x,y,width,height,false);
  return bytes && {bytes,offset:(y*owned.width+x)*4,stride:owned.width*4};
}

function rasterPixels(owned,x,y,width,height,premultiplied) {
  const {kit,memory}=owned;
  const bytes=owned.width*owned.height*4;
  const start=memory.byteOffset;
  if(!Number.isSafeInteger(start)||start<0||start+bytes>kit.HEAPU8.byteLength)return null;
  const source=new Uint8Array(kit.HEAPU8.buffer,start,bytes);
  if (!premultiplied) {
    // CanvasKit malloc aligns the RGBA rows. Reduce eight pixels at once;
    // all alpha bits survive the AND only if every pixel is opaque.
    if (start % 4 !== 0) return null;
    const words = new Uint32Array(source.buffer, start, bytes / 4);
    for (let row = 0; row < height; row++) {
      let i = (y + row) * owned.width + x;
      const end = i + width;
      for (; i + 7 < end; i += 8) {
        const common = words[i] & words[i+1] & words[i+2] & words[i+3]
          & words[i+4] & words[i+5] & words[i+6] & words[i+7];
        if ((common & alphaMask) !== alphaMask) return null;
      }
      for (; i < end; i++) if ((words[i] & alphaMask) !== alphaMask) return null;
    }
  }
  return source;
}

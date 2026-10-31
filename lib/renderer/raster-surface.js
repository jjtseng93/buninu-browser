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
    let disposed=false;
    surface.dispose=()=>{if(disposed)return;disposed=true;surface.delete();kit.Free(memory);};
    return surface;
  } catch(error) {surface?.delete();kit.Free(memory);throw error;}
}

import {copyRasterSurfacePixels} from '../renderer/raster-surface.js';

/**
 * A reusable native readback buffer and immutable JavaScript pixel snapshots.
 * Shared snapshots cross the renderer/compositor worker boundary without
 * copying another full raster tile. Each snapshot owns its buffer: encoding
 * an old frame can safely overlap painting the next one.
 */
export class RasterReadback {
  #kit;
  #shared;
  #scratch = null;
  #allocate;

  constructor(kit, { shared = false, allocate = null } = {}) {
    this.#kit = kit;
    this.#shared = shared;
    this.#allocate = allocate;
  }

  read(image,width,height,options={}) {
    return this.#read(image,null,width,height,options);
  }

  readSurface(surface,width,height,options={}) {
    return this.#read(null,surface,width,height,options);
  }

  #read(image,surface,width,height,{premultiplied=false,previous=null,region=null,allocate=this.#allocate}={}) {
    const kit = this.#kit;
    const bytes = width * height * 4;
    const partial = previous?.length === bytes && region
      && [region.x,region.y,region.width,region.height].every(Number.isInteger)
      && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
      && region.x + region.width <= width && region.y + region.height <= height;
    const x=partial?region.x:0,y=partial?region.y:0;
    const rw=partial?region.width:width,rh=partial?region.height:height;
    const pixels = allocate ? allocate(bytes)
      : new Uint8Array(this.#shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
    if(partial)pixels.set(previous);
    if(surface&&copyRasterSurfacePixels(surface,pixels,{x,y,width:rw,height:rh,
      offset:(y*width+x)*4,stride:width*4,premultiplied}))return pixels;
    if (!this.#scratch || this.#scratch.length < bytes) {
      this.dispose();
      this.#scratch = kit.Malloc(Uint8Array, bytes);
    }
    if(surface)image=surface.makeImageSnapshot();
    try{
      const native=image.readPixels(x,y,{
        width:rw,height:rh,colorType:kit.ColorType.RGBA_8888,
        alphaType:premultiplied?kit.AlphaType.Premul:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB,
      },this.#scratch,rw*4);
      if(!native)throw new Error("Unable to read raster pixels");
      if(partial){
        for(let row=0;row<rh;row++)pixels.set(native.subarray(row*rw*4,(row+1)*rw*4),((y+row)*width+x)*4);
      }else pixels.set(native.subarray(0,bytes));
      return pixels;
    }finally{if(surface)image.delete();}
  }

  dispose() {
    if (this.#scratch) this.#kit.Free(this.#scratch);
    this.#scratch = null;
  }
}

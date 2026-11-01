// The pixel blend from buninu-land's direct-compositor.ts, used without its
// Wayland scene/viewport machinery. Channels are symmetric, so the same math
// handles browser RGBA words as well as Land's BGRA words. Input is premultiplied;
// a fully opaque result is also valid ordinary RGBA for existing frame consumers.
const littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
function blend(p: number, q: number, alpha: number): number {
  const inverse = 255 - alpha;
  const blue = Math.min(255, (p & 255) + Math.round(((q & 255) * inverse) / 255));
  const green = Math.min(255, ((p >> 8) & 255) + Math.round((((q >> 8) & 255) * inverse) / 255));
  const red = Math.min(255, ((p >> 16) & 255) + Math.round((((q >> 16) & 255) * inverse) / 255));
  return (0xff000000 | (red << 16) | (green << 8) | blue) >>> 0;
}
export function compositeCanvasOverOpaque(pixels: Uint8Array, background: readonly number[]): void {
  if(littleEndian&&pixels.byteOffset%4===0){
    const words=new Uint32Array(pixels.buffer,pixels.byteOffset,pixels.byteLength/4);
    const bg=(0xff000000|(background[2]!<<16)|(background[1]!<<8)|background[0]!)>>>0;
    for(let i=0;i<words.length;i++){
      const p=words[i]!,alpha=p>>>24;
      if(alpha!==255)words[i]=alpha===0?bg:blend(p,bg,alpha);
    }
  }else{
    for(let i=0;i<pixels.length;i+=4){
      const alpha=pixels[i+3]!;
      if(alpha===255)continue;
      for(let c=0;c<3;c++)pixels[i+c]=Math.min(255,pixels[i+c]!+Math.round(background[c]!*(255-alpha)/255));
      pixels[i+3]=255;
    }
  }
}

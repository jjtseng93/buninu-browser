// Fragment outputs and floating-point attachments store all four channels
// independently. In particular, alpha zero is valid data in a render target.
export const blendEnums = {
  SRC_COLOR:768, ONE_MINUS_SRC_COLOR:769, DST_ALPHA:772, ONE_MINUS_DST_ALPHA:773,
  DST_COLOR:774, ONE_MINUS_DST_COLOR:775, SRC_ALPHA_SATURATE:776,
  CONSTANT_COLOR:32769, ONE_MINUS_CONSTANT_COLOR:32770, CONSTANT_ALPHA:32771, ONE_MINUS_CONSTANT_ALPHA:32772,
  FUNC_SUBTRACT:32778, FUNC_REVERSE_SUBTRACT:32779, MIN:32775, MAX:32776,
};
const unit = x => Math.max(0, Math.min(1, x));

function factor(which,c,src,s,dst,d,scale,constant){
  switch(which){
    case 0:return 0; case 1:return 1;
    case 768:return src[s+c]; case 769:return 1-src[s+c];
    case 770:return src[s+3]; case 771:return 1-src[s+3];
    case 772:return dst[d+3]*scale; case 773:return 1-dst[d+3]*scale;
    case 774:return dst[d+c]*scale; case 775:return 1-dst[d+c]*scale;
    case 776:return c===3?1:Math.min(src[s+3],1-dst[d+3]*scale);
    case 32769:return constant[c]; case 32770:return 1-constant[c];
    case 32771:return constant[3]; case 32772:return 1-constant[3];
  }
  return 0;
}

export function writeFragment(src,s,target,d,blend,blending){
  const float=target instanceof Float32Array,scale=float?1:1/255;
  // Alpha is written last, so the original destination alpha is still
  // available for the RGB blend factors.
  for(let c=0;c<4;c++){
    if(!blend.mask[c])continue;
    let value=src[s+c];
    if(blending){
      const alpha=c===3,eq=blend.equations[alpha?1:0],old=target[d+c]*scale;
      if(eq===32775)value=Math.min(value,old);
      else if(eq===32776)value=Math.max(value,old);
      else{
        const a=value*factor(blend.factors[alpha?2:0],c,src,s,target,d,scale,blend.color);
        const b=old*factor(blend.factors[alpha?3:1],c,src,s,target,d,scale,blend.color);
        value=eq===32778?a-b:eq===32779?b-a:a+b;
      }
    }
    target[d+c]=float?value:Math.round(unit(value)*255);
  }
}

// Bind fixed draw state once for ordered fragments on an RGBA8 attachment.
export function fragmentWriter(source,target,blend,blending) {
  if (!(target instanceof Uint8Array) || !blending || !blend.mask.every(Boolean) ||
      !blend.equations.every(eq=>eq===0x8006) ||
      !blend.factors.every((factor,i)=>factor===(i%2 ? 771 : 770))) {
    return d=>writeFragment(source,0,target,d,blend,blending);
  }
  const scale=1/255;
  return d=>{
    const alpha=source[3];
    if (alpha===0 && Number.isFinite(source[0]) && Number.isFinite(source[1]) && Number.isFinite(source[2])) return;
    if (alpha===1) {
      target[d]=Math.round(unit(source[0])*255);
      target[d+1]=Math.round(unit(source[1])*255);
      target[d+2]=Math.round(unit(source[2])*255);
      target[d+3]=255;
      return;
    }
    const inverse=1-alpha;
    for(let c=0;c<4;c++){
      const value=source[c]*alpha+(target[d+c]*scale)*inverse;
      target[d+c]=Math.round(unit(value)*255);
    }
  };
}

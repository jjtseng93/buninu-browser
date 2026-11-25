// The default drawing buffer belongs to the canvas. User framebuffers reference
// texture levels and renderbuffer storage, so attachment contents survive a
// rebind and are shared between framebuffers referencing the same image.
export const fbEnums = {
  FRAMEBUFFER_BINDING:0x8ca6, RENDERBUFFER_BINDING:0x8ca7, READ_FRAMEBUFFER:0x8ca8,
  DRAW_FRAMEBUFFER:0x8ca9, READ_FRAMEBUFFER_BINDING:0x8caa,
  COLOR_ATTACHMENT0:0x8ce0, DEPTH_ATTACHMENT:0x8d00, STENCIL_ATTACHMENT:0x8d20,
  DEPTH_STENCIL_ATTACHMENT:0x821a, DEPTH_COMPONENT:0x1902, DEPTH_COMPONENT16:0x81a5,
  DEPTH_COMPONENT24:0x81a6, DEPTH24_STENCIL8:0x88f0, RGBA8:0x8058, RGBA16F:0x881a,
  RGBA32F:0x8814, HALF_FLOAT:0x140b, MAX_SAMPLES:0x8d57, MAX_DRAW_BUFFERS:0x8824,
  MAX_COLOR_ATTACHMENTS:0x8cdf, FRAMEBUFFER_INCOMPLETE_ATTACHMENT:0x8cd6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:0x8cd7, FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:0x8d56,
  RENDERBUFFER_SAMPLES:0x8cab, RENDERBUFFER_WIDTH:0x8d42, RENDERBUFFER_HEIGHT:0x8d43,
  RENDERBUFFER_INTERNAL_FORMAT:0x8d44, SAMPLES:0x80a9, SAMPLE_BUFFERS:0x80a8, NONE:0,
};
export function framebufferState(textures, flush, fail) {
  const frames=new WeakMap(), renders=new WeakMap();
  let draw=null, read=null, render=null;
  function create(map,tag,data) {
    const handle=Object.create(null);
    Object.defineProperty(handle,Symbol.toStringTag,{value:tag});
    map.set(handle,data);
    return handle;
  }
  const frame=target=>frames.get(target===0x8ca8?read:draw);
  function attach(target,point,reference) {
    const f=frame(target);
    if(!f)return fail(0x502);
    flush();
    if(reference)f.attachments.set(point,reference);
    else f.attachments.delete(point);
  }
  function level(reference){
    if(!reference)return null;
    if(reference.render)return renders.get(reference.render);
    return textures.level(reference.texture,reference.face,reference.level);
  }
  function storage(target,samples,format,width,height){
    if(target!==0x8d41)return fail(0x500);
    if(!render)return fail(0x502);
    if(width<0||height<0||width>4096||height>4096||samples<0||samples>4)return fail(0x501);
    flush();
    renders.set(render,{width,height,format,samples:samples===3?4:samples});
  }
  function status(f) {
    if(!f)return 0x8cd5;
    if(!f.attachments.size)return 0x8cd7;
    let samples;
    for(const ref of f.attachments.values()){
      const image=level(ref);
      if(!image?.width||!image.height)return 0x8cd6;
      const count=image.samples??0;
      if(samples!==undefined&&samples!==count)return 0x8d56;
      samples=count;
    }
    return 0x8cd5;
  }
  function describe(handle,slot=0,reading=false){
    const f=frames.get(handle);
    if(!f||status(f)!==0x8cd5)return null;
    const ref=f.attachments.get(reading?f.readColor:f.colors[slot]);
    const depthRef=f.attachments.get(0x8d00)??f.attachments.get(0x821a);
    const color=level(ref), depth=level(depthRef);
    const size=color??depth??level(f.attachments.values().next().value);
    if(!size?.width||!size.height)return null;
    return {width:size.width,height:size.height,samples:size.samples??0,color,ref,depth,depthRef};
  }
  return {
    draw:()=>draw, read:()=>read, render:()=>render, describe, slots:()=>frames.get(draw)?.colors.length??1,
    sampleParameter(pname){
      const count=describe(draw)?.samples??0;
      return pname===0x80a9?count:Number(count>0);
    },
    attachedToDraw(handle){
      const f=frames.get(draw);
      if(f)for(const ref of f.attachments.values())if(ref.texture===handle)return true;
      return false;
    },
    methods:{
      createFramebuffer:()=>create(frames,'WebGLFramebuffer',{attachments:new Map(),colors:[0x8ce0],readColor:0x8ce0}),
      bindFramebuffer(target,handle){
        if(![0x8d40,0x8ca8,0x8ca9].includes(target))return fail(0x500);
        if(handle!==null&&!frames.has(handle))return fail(0x502);
        flush();
        if(target!==0x8ca8)draw=handle;
        if(target!==0x8ca9)read=handle;
      },
      deleteFramebuffer(handle){flush();if(draw===handle)draw=null;if(read===handle)read=null;frames.delete(handle);},
      framebufferTexture2D(target,point,face,texture,level){attach(target,point,texture?{face,texture,level}:null);},
      framebufferRenderbuffer(target,point,type,render){attach(target,point,render?{render}:null);},
      checkFramebufferStatus:target=>status(frame(target)),
      createRenderbuffer:()=>create(renders,'WebGLRenderbuffer',{}),
      bindRenderbuffer(target,handle){
        if(target!==0x8d41)return fail(0x500);
        if(handle&&!renders.has(handle))return fail(0x502);
        render=handle;
      },
      renderbufferStorage:(target,format,w,h)=>storage(target,0,format,w,h),
      renderbufferStorageMultisample:storage,
      getRenderbufferParameter(target,pname){
        if(target!==0x8d41){fail(0x500);return null;}
        if(!render){fail(0x502);return null;}
        const image=renders.get(render);
        switch(pname){
          case 0x8cab:return image.samples??0;
          case 0x8d42:return image.width??0;
          case 0x8d43:return image.height??0;
          case 0x8d44:return image.format??0x8056;
          default:fail(0x500);return null;
        }
      },
      deleteRenderbuffer(handle){flush();if(render===handle)render=null;renders.delete(handle);},
      readBuffer(point){const f=frames.get(read);if(f){flush();f.readColor=point;}},
      drawBuffers(points){const f=frames.get(draw);if(f){flush();f.colors=Array.from(points);}},
    }
  };
}

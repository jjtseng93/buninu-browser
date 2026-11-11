const hostSetTimeout=globalThis.setTimeout, hostClearTimeout=globalThis.clearTimeout;

// One decoder per consumer; only the current composed frame is retained.
// Skia handles GIF transparency, disposal, frame rectangles and loop counts.
export function createAnimatedImage(kit, bytes, changed, clock = {}) {
 const decoder=kit.MakeAnimatedImageFromEncoded(bytes);
 if(!decoder)return null;
 if(decoder.getFrameCount()<2){decoder.delete();return null;}
 const later=clock.setTimeout??hostSetTimeout, cancel=clock.clearTimeout??hostClearTimeout;
 let image, timer=null, disposed=false, playing=true, paused=false, visible=true, ended=false, started=false, frame=0;
 try{image=decoder.makeImageAtCurrentFrame();if(!image)throw Error('Missing GIF frame');}
 catch(error){decoder.delete();throw error;}
 let snapshot=null;
 const delay=()=>{const n=decoder.currentFrameDuration();return n<0?-1:n<=10?100:n;};
 function schedule(){
  if(disposed||!started||!playing||paused||!visible||ended||timer!==null)return;
  const ms=delay();if(ms<0){ended=true;return;}
  timer=later(tick,ms);timer?.unref?.();
 }
 function tick(){
  timer=null;if(disposed)return;
  try{
   const duration=decoder.decodeNextFrame();
   const next=decoder.makeImageAtCurrentFrame();if(!next)throw Error('Missing GIF frame');
   const old=image;image=next;snapshot=null;old.delete();
   frame=(frame+1)%decoder.getFrameCount();
   ended=duration<0;changed();controller.onFrame?.();schedule();
  }catch{ended=true;} // Keep the last good frame until its resource is released.
 }
 const controller={
  get image(){return image;},
  get frame(){return frame;},
  get frameCount(){return decoder.getFrameCount();},
  snapshot(resource){return snapshot??=Object.freeze({...resource,image});},
  start(){started=true;schedule();},
  setVisible(value){
   value=Boolean(value);if(disposed||visible===value)return;visible=value;
   if(!visible&&timer!==null){cancel(timer);timer=null;}
   if(visible)schedule();
  },
  configure(options={}){
   if(disposed)return;
   if(options.playing!==undefined){
    const next=Boolean(options.playing);
    if(next&&!playing){decoder.reset();const old=image;image=decoder.makeImageAtCurrentFrame();old.delete();snapshot=null;frame=0;ended=false;changed();controller.onFrame?.();}
    playing=next;
   }
   if(options.paused!==undefined)paused=Boolean(options.paused);
   if(timer!==null){cancel(timer);timer=null;}schedule();
  },
  delete(){
   if(disposed)return;disposed=true;
   if(timer!==null)cancel(timer);timer=null;
   image?.delete();image=null;snapshot=null;decoder.delete();
   controller.onDispose?.();controller.onDispose=null;controller.onFrame=null;
  }
 };
 return controller;
}
export const imageOwner=resource=>resource.animation??resource.image;
export const imageSnapshot=resource=>resource?.animation?resource.animation.snapshot(resource):resource;

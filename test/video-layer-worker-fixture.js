import {captureVideoViewport} from '../lib/renderer/video-presentation.js';
let retired = null;
self.onmessage = ({data}) => {
  if(data.save){retired=data.tile;postMessage({id:data.id,baseShared:retired.videoLayer.base.buffer instanceof SharedArrayBuffer,maskShared:retired.videoLayer.mask.buffer instanceof SharedArrayBuffer});return;}
  const {tile,frame}=data;
  const capture=captureVideoViewport(tile,frame,0,0,4,3,undefined,data.format);
  const oldBase=new Uint8Array(retired.videoLayer.base),oldMask=new Uint8Array(retired.videoLayer.mask);
  postMessage({id:data.id,pixels:capture.pixels,oldBase,oldMask},[capture.pixels.buffer,oldBase.buffer,oldMask.buffer]);
};

import {test,expect} from 'bun:test';
import {captureVideoViewport} from '../lib/renderer/video-presentation.js';

test('published shared video layers retain retired pixels while private captures transfer',async()=>{
 const make=seed=>{
  const base=new Uint8Array(new SharedArrayBuffer(4*3*4)),mask=new Uint8Array(new SharedArrayBuffer(base.length));
  for(let i=0;i<base.length;i+=4){base.set([seed,seed+3,seed+7,255],i);mask.set(i%8?[127,80,190,0]:[255,255,255,0],i);}
  return {x:0,y:0,width:4,height:3,scale:1,pixelWidth:4,pixelHeight:3,pixels:new Uint8Array(new SharedArrayBuffer(base.length)),
   videoLayer:{base,mask,rect:{x:0,y:0,width:4,height:3}}};
 };
 const old=make(5),oldBase=new Uint8Array(old.videoLayer.base),oldMask=new Uint8Array(old.videoLayer.mask);
 const worker=new Worker(new URL('./video-layer-worker-fixture.js',import.meta.url).href),waiters=new Map();let id=0;
 worker.onmessage=({data})=>{waiters.get(data.id)?.(data);waiters.delete(data.id)};
 const send=data=>new Promise(resolve=>{data.id=++id;waiters.set(id,resolve);worker.postMessage(data)});
 try{
  const saved=await send({save:true,tile:old});expect(saved.baseShared).toBe(true);expect(saved.maskShared).toBe(true);
  const next=make(19),frame={pixels:Uint8Array.from({length:2*2*4},(_,i)=>i*13),width:2,height:2};
  for(const format of ['rgba','bgra']){
   const expected=captureVideoViewport(next,frame,0,0,4,3,undefined,format);
   const received=await send({tile:next,frame,format});
   expect(received.pixels).toEqual(expected.pixels);expect(received.pixels.buffer instanceof ArrayBuffer).toBe(true);
   expect(received.oldBase).toEqual(oldBase);expect(received.oldMask).toEqual(oldMask);
   received.pixels.buffer.transfer(0);expected.pixels.buffer.transfer(0);
   expect(old.videoLayer.base).toEqual(oldBase);expect(old.videoLayer.mask).toEqual(oldMask);
  }
 }finally{worker.terminate()}
});

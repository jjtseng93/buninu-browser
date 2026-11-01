import {test,expect} from 'bun:test';
import {mp4FrameTimes,timeVideoDecoder} from '../lib/media/mp4-frame-times.js';
const words=(...ns)=>{const b=new Uint8Array(ns.length*4),v=new DataView(b.buffer);ns.forEach((n,i)=>v.setUint32(i*4,n));return b};
const box=(name,...parts)=>{const body=Buffer.concat(parts),head=Buffer.alloc(8);head.writeUInt32BE(body.length+8);head.write(name,4);return Buffer.concat([head,body])};
function movie(){return box('moov',box('trak',box('mdia',
 box('hdlr',words(0,0,0x76696465)),box('mdhd',words(0,0,0,1000)),
 box('minf',box('stbl',box('stts',words(0,3,1,50,1,100,2,25)),box('stss',words(0,2,1,3)))))))}
test('MP4 variable-rate frames use sample times rather than average FPS',()=>{
 const t=mp4FrameTimes(movie());expect([...t.frames]).toEqual([0,.05,.15,.175]);expect(t.end).toBe(.2);
 let seek;const decoder=timeVideoDecoder({width:2,height:2,fps:20,nextFrame:()=>new Uint8Array(16),seek:ms=>seek=ms,close(){}},movie());
 decoder.nextFrame();expect(decoder.frameTime).toBe(0);expect(decoder.nextFrameTime).toBe(.05);
 decoder.nextFrame();expect(decoder.frameTime).toBe(.05);expect(decoder.nextFrameTime).toBe(.15);
 decoder.seek(160);expect(seek).toBe(160);decoder.nextFrame();expect(decoder.frameTime).toBe(.15);
});
test('unsupported or truncated containers retain the original decoder',()=>{
 const decoder={};for(const data of [new Uint8Array(),movie().subarray(0,20),box('free',words(0))]){
 expect(mp4FrameTimes(data)).toBeNull();expect(timeVideoDecoder(decoder,data)).toBe(decoder);
 }
});

test('composition offsets and an edit map reordered samples onto presentation time',()=>{
 const data=box('moov',box('trak',
  box('edts',box('elst',words(0,1,200,50,65536))),
  box('mdia',box('hdlr',words(0,0,0x76696465)),box('mdhd',words(0,0,0,1000)),
   box('minf',box('stbl',box('stts',words(0,1,4,50)),
    box('ctts',words(0,4,1,50,1,100,1,0,1,50)),box('stss',words(0,1,1)))))));
 const t=mp4FrameTimes(data);expect([...t.frames]).toEqual([0,.05,.1,.15]);expect(t.end).toBe(.2);
});
test('a progressive mdat does not hide already complete sample timing tables',()=>{
 const head=movie(),payload=box('mdat',new Uint8Array(1000));
 const t=mp4FrameTimes(Buffer.concat([head,payload.subarray(0,16)]));
 expect([...t.frames]).toEqual([0,.05,.15,.175]);
});

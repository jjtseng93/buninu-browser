import {expect,test} from 'bun:test';
import {mp4KeyframeBefore} from '../lib/media/mp4-keyframes.js';

async function fixture(){return new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4',import.meta.url)).arrayBuffer());}
function findBox(bytes,type){
  for(let i=4;i+4<=bytes.length;i++)if(String.fromCharCode(...bytes.subarray(i,i+4))===type)return i+4;
  throw Error(`missing ${type}`);
}

test('fMP4 sync-sample candidates retain absolute decode times',async()=>{
  const bytes=await fixture();
  expect([0,1.9,2,3.9,4,20].map(time=>mp4KeyframeBefore(bytes,time))).toEqual([0,0,2,2,4,4]);
  expect(mp4KeyframeBefore(bytes,-1)).toBeNull();
  expect(mp4KeyframeBefore(bytes,Infinity)).toBeNull();
});

test('invalid and unsupported MP4 layouts decline indexing without throwing',async()=>{
  const source=await fixture();
  for(const change of [
    (b,v)=>v.setUint32(0,4), // invalid root box
    (b,v)=>v.setUint32(0,0xffffffff), // truncated root box
    (b,v)=>v.setUint32(findBox(b,'trun')+4,0xffffffff), // bounded sample work
    (b,v)=>v.setUint32(findBox(b,'trun'),0x00000404), // conflicting flag tables
    (b,v)=>v.setUint32(findBox(b,'tfhd'),0x00040000), // unknown fragment flags
    (b,v)=>v.setUint32(findBox(b,'mdhd')+12,0), // no timescale
    (b,v)=>{const at=findBox(b,'tfdt');b[at]=2;}, // unknown timing version
    (b,v)=>{const at=findBox(b,'trex');v.setUint32(at+4,999);}, // unmatched track
  ]){
    const bytes=source.slice();change(bytes,new DataView(bytes.buffer));
    expect(mp4KeyframeBefore(bytes,3)).toBeNull();
    expect(mp4KeyframeBefore(bytes,3)).toBeNull(); // a declined index is cached too
  }
  for(const length of [0,1,7,16,source.length-1])expect(mp4KeyframeBefore(source.slice(0,length),3)).toBeNull();
  const ordinary=new Uint8Array(await Bun.file(new URL('./fixtures/video.mp4',import.meta.url)).arrayBuffer());
  expect(mp4KeyframeBefore(ordinary,2)).toBeNull();
});

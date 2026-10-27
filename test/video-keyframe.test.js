import { expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { seekVideoKeyframe } from '../lib/media/video-keyframe.js';
import { mp4KeyframeBefore } from '../lib/media/mp4-keyframes.js';

function withEditList(bytes, rate = 0x00010000) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const find=(from,end,type)=>{
    for(let at=from;at+8<=end;at+=view.getUint32(at)){
      const size=view.getUint32(at);
      if(size<8||at+size>end)break;
      if(String.fromCharCode(...bytes.subarray(at+4,at+8))===type)return {at,end:at+size};
    }
    throw Error(`missing ${type}`);
  };
  const moov=find(0,bytes.length,'moov'),trak=find(moov.at+8,moov.end,'trak');
  const edit=new Uint8Array(36),ev=new DataView(edit.buffer);
  ev.setUint32(0,36);edit.set([101,100,116,115],4); // edts
  ev.setUint32(8,28);edit.set([101,108,115,116],12); // elst
  ev.setUint32(20,1);ev.setUint32(24,6000);ev.setInt32(28,2048);ev.setUint32(32,rate);
  const out=new Uint8Array(bytes.length+edit.length),ov=new DataView(out.buffer);
  out.set(bytes.subarray(0,trak.end));out.set(edit,trak.end);out.set(bytes.subarray(trak.end),trak.end+edit.length);
  ov.setUint32(moov.at,view.getUint32(moov.at)+edit.length);ov.setUint32(trak.at,view.getUint32(trak.at)+edit.length);
  return out;
}

test('seeking within a GOP longer than ten seconds preserves the decoded frame timestamp', async () => {
  await wasmpeg.load();
  const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/long-video.mp4', import.meta.url)).arrayBuffer());
  const decoder = await wasmpeg.decode(bytes);
  try {
    // This thirty-second fixture has a different picture at every frame,
    // but only its first frame is a keyframe.
    const firstHash = Bun.hash(decoder.nextFrame(32, 18));
    for (const target of [15, 20, 25, 29]) {
      const timestamp = seekVideoKeyframe(decoder, target);
      expect(Bun.hash(decoder.nextFrame(32, 18))).toBe(firstHash);
      expect(timestamp).toBe(0);
    }
  } finally { decoder.close(); }
});

test('a later MP4 initialization keeps absolute seek times, including seeks back across its first GOP', async () => {
  await wasmpeg.load();
  const bytes = new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4', import.meta.url)).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const visit = (from, to, callback) => {
    for (let offset = from; offset + 8 <= to;) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > to) break;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      callback(type, offset + 8);
      if (['moov', 'trak', 'mdia', 'moof', 'traf'].includes(type)) visit(offset + 8, offset + size, callback);
      offset += size;
    }
  };
  let timescale;
  visit(0, bytes.length, (type, data) => {
    if (type === 'mdhd') timescale = view.getUint32(data + (bytes[data] === 1 ? 20 : 12));
  });
  let fragments = 0;
  visit(0, bytes.length, (type, data) => {
    if (type !== 'tfdt') return;
    fragments++;
    if (bytes[data] === 1) view.setBigUint64(data + 4, view.getBigUint64(data + 4) + BigInt(6 * timescale));
    else view.setUint32(data + 4, view.getUint32(data + 4) + 6 * timescale);
  });
  expect(fragments).toBeGreaterThan(0);
  const decoder = await wasmpeg.decode(bytes, { format: 'mp4' });
  try {
    const hashes = [];
    for (let pixels; (pixels = decoder.nextFrame(32, 18));) hashes.push(Bun.hash(pixels));
    expect(hashes).toHaveLength(60);
    // The fixture's keyframes are 2s apart. After moving tfdt by six seconds,
    // seek(8s) must return frame 20, not frame 0 or an offset-relative frame.
    for (const [target, frame, expectedTime] of [[6, 0, 6], [7.9, 0, 6], [8, 20, 8], [11, 40, 10], [6.2, 0, 6], [5, 0, 6]]) {
      for(const index of [null,bytes]){
        const timestamp = seekVideoKeyframe(decoder, target, 6,index);
        expect(Bun.hash(decoder.nextFrame(32, 18))).toBe(hashes[frame]);
        expect(timestamp).toBeGreaterThanOrEqual(expectedTime);
        expect(timestamp).toBeLessThan(expectedTime + 1 / decoder.fps);
      }
    }
  } finally { decoder.close(); }
});

test('verified fMP4 candidates reduce probes and preserve subsequent full-size frames',async()=>{
  await wasmpeg.load();
  for(const name of ['mse-switch-small.mp4','mse-switch-large.mp4']){
    const bytes=new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`,import.meta.url)).arrayBuffer());
    const decoder=await wasmpeg.decode(bytes,{format:'mp4'});
    let probes=0;
    const counted={fps:decoder.fps,seek:time=>decoder.seek(time),nextFrame:(...args)=>{probes++;return decoder.nextFrame(...args);}};
    try{
      for(const [target,keyframe] of [[1.9,0],[2,2],[3.99,2],[4,4],[5.8,4]]){
        probes=0;const baselineTime=seekVideoKeyframe(counted,target),baselineProbes=probes;
        const expected=[];
        for(let i=0;i<8;i++)expected.push(decoder.nextFrame());
        probes=0;const indexedTime=seekVideoKeyframe(counted,target,0,bytes);
        expect(indexedTime).toBe(keyframe);
        expect(Math.abs(indexedTime-baselineTime)).toBeLessThan(1/decoder.fps);
        expect(probes).toBeLessThanOrEqual(3);
        if(keyframe)expect(probes).toBeLessThan(baselineProbes);
        else expect(probes).toBeLessThanOrEqual(baselineProbes);
        for(const pixels of expected)expect(decoder.nextFrame()).toEqual(pixels);
      }
    }finally{decoder.close();}
  }
});

test('a mismatched candidate or indistinguishable pictures retain the original seek search',async()=>{
  const bytes=new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4',import.meta.url)).arrayBuffer());
  for(const staticPicture of [false,true]){
    let position=0;
    const decoder={fps:10,seek(ms){position=Math.floor(ms/3000)*3;},nextFrame(){return new Uint8Array([staticPicture?1:position,9,7,255]);}};
    const baseline=seekVideoKeyframe(decoder,3.9);
    const indexed=seekVideoKeyframe(decoder,3.9,0,bytes);
    expect(indexed).toBe(baseline);
    expect(position).toBe(staticPicture?0:3);
  }
});

test('failed optional candidate probes fall back, while original search errors still propagate',async()=>{
  const bytes=new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4',import.meta.url)).arrayBuffer());
  const makeDecoder=(failAt,method)=>{
    let time=0;
    return {fps:10,seek(ms){time=ms;if(method==='seek'&&ms===failAt)throw Error('seek failure');},
      nextFrame(){if(method==='nextFrame'&&time===failAt)throw Error('decode failure');return new Uint8Array([Math.floor(time/2000),9,7,255]);}};
  };
  const baseline=seekVideoKeyframe(makeDecoder(-1,'seek'),3.9);
  for(const method of ['seek','nextFrame']){
    expect(seekVideoKeyframe(makeDecoder(2000,method),3.9,0,bytes)).toBe(baseline);
    expect(()=>seekVideoKeyframe(makeDecoder(3900,method),3.9,0,bytes)).toThrow();
    expect(()=>seekVideoKeyframe(makeDecoder(1,method),3.9,0,null)).toThrow();
  }
});

test('an unreadable preceding probe cannot verify a candidate boundary',async()=>{
  const bytes=new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4',import.meta.url)).arrayBuffer());
  let time=0;
  const decoder={fps:10,seek(ms){time=ms;},nextFrame(){return time===1900?null:new Uint8Array([Math.floor(time/2000),9,7,255]);}};
  const baseline=seekVideoKeyframe(decoder,3.9);
  expect(baseline).toBeGreaterThan(2);
  expect(seekVideoKeyframe(decoder,3.9,0,bytes)).toBe(baseline);
});

test('a simple edit list is only a verified seek candidate, while rate-changing edits decline',async()=>{
  await wasmpeg.load();
  const original=new Uint8Array(await Bun.file(new URL('./fixtures/mse-switch-large.mp4',import.meta.url)).arrayBuffer());
  expect(mp4KeyframeBefore(withEditList(original,0x00020000),3.5)).toBeNull();
  const bytes=withEditList(original),decoder=await wasmpeg.decode(bytes,{format:'mp4'});
  try{
    for(const target of [2.8,4.7]){
      const baseline=seekVideoKeyframe(decoder,target),expected=[];
      for(let i=0;i<8;i++)expected.push(decoder.nextFrame());
      const indexed=seekVideoKeyframe(decoder,target,0,bytes);
      expect(Math.abs(indexed-baseline)).toBeLessThan(1/decoder.fps);
      for(const pixels of expected)expect(decoder.nextFrame()).toEqual(pixels);
    }
  }finally{decoder.close();}
});

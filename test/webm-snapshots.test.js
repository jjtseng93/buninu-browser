import { beforeAll, expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { createMediaSourceScope } from '../lib/renderer/media-source.js';
import { createWebMStream, ebmlHeader } from '../lib/media/webm-stream.js';
import { advanceAudio } from '../lib/media/position-audio.js';

let fixture, elements, clusters, init;
const join = parts => new Uint8Array(Bun.concatArrayBuffers(parts));
beforeAll(async () => {
  await wasmpeg.load();
  fixture = await Bun.file(new URL('./fixtures/mse-audio-chirp.webm', import.meta.url)).bytes();
  elements = createWebMStream().append(fixture);
  clusters = elements.filter(element => element.id === 0x1f43b675);
  init = join(elements.slice(0, elements.indexOf(clusters[0])).map(element => element.bytes));
});
function context() {
  const tasks = [], scope = createMediaSourceScope({ origin:'https://gap.test', schedule:fn=>tasks.push(fn), DOMException });
  const flush = () => { while(tasks.length) tasks.shift()(); };
  const source = new scope.MediaSource();source.attach('blob:https://gap.test/audio');flush();
  const buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
  return {source, buffer, append(bytes){buffer.appendBuffer(bytes);flush();}};
}
async function decode(bytes) {
  const decoder=await wasmpeg.decodeAudio(bytes,{format:'webm'}), chunks=[];
  try { for(let samples;(samples=decoder.nextSamples());)chunks.push(samples); }
  finally { decoder.close(); }
  return new Float32Array(Bun.concatArrayBuffers(chunks));
}
function live(bytes) {
  const result=bytes.slice(), header=ebmlHeader(bytes), width=header.length-4;
  result[4]=(1 << (9-width))-1;result.fill(0xff,5,header.length);
  return result;
}

test('continuous Opus retains its original bytes, pre-skip and every PCM sample',async()=>{
  const c=context();c.append(fixture);c.source.endOfStream();
  const selected=c.buffer._pipe.snapshotAt(7);
  expect(selected.id).toBeGreaterThan(0);
  expect(selected.startTime).toBe(0);
  expect(selected.bytes).toBe(c.buffer._pipe.bytes());
  expect(await decode(selected.bytes)).toEqual(await decode(fixture));
});

test.each([false,true])('a sparse %s live WebM seek reaches the target instead of waiting for missing earlier PCM',async unknown=>{
  const c=context();c.append(init);
  for(const index of [0,3]){
    const bytes=unknown?live(clusters[index].bytes):clusters[index].bytes;
    for(let at=0;at<bytes.length;at+=137)c.append(bytes.subarray(at,at+137));
  }
  const pipe=c.buffer._pipe, first=pipe.snapshotAt(0), selected=pipe.snapshotAt(7);
  expect(selected.startTime).toBe(5.981);
  expect(selected.endTime).toBe(Infinity);
  expect(first.endTime).toBe(selected.startTime);
  expect(selected.id).not.toBe(first.id);
  const reference=await decode(join([init,clusters[3].bytes]));
  // Decode the retained run with its original CodecDelay/OpusHead. Its first
  // decoded sample is at 5.981s (FFmpeg's frame PTS), not at zero or at seek7.
  expect(await decode(selected.bytes)).toEqual(reference);
  let sound, opens=0, active=true;
  const open=async time=>{
    const selected=pipe.snapshotAt(time),decoder=await wasmpeg.decodeAudio(selected.bytes,{format:'webm'});
    sound?.decoder.close();opens++;
    sound={...selected,decoder,position:Math.round(selected.startTime*decoder.sampleRate),pending:null,
      pipe,openedGeneration:pipe.generation,snapshotId:selected.id};
    return true;
  };
  await open(0);
  let timer;
  try {
    const reached=await Promise.race([
      advanceAudio(()=>sound,7,{needsMore:()=>true,active:()=>active,reopen:()=>open(7)}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('seek waited for missing timeline')),500);}),
    ]);
    expect(reached).toBe(true);expect(opens).toBe(2);expect(sound.position).toBe(7*48000);
    const pending=sound.pending??sound.decoder.nextSamples(), offset=Math.round((7-selected.startTime)*48000);
    expect(pending).toEqual(reference.subarray(offset,offset+pending.length));
    expect(pipe.snapshotAt(0).bytes).toEqual(first.bytes);
  } finally { clearTimeout(timer);active=false;pipe.finish();sound.decoder.close(); }
});

test('out-of-order clusters can fill a hole without retaining the old arrival order',async()=>{
  const c=context();c.append(init);c.append(clusters[0].bytes);c.append(clusters[3].bytes);
  const old=c.buffer._pipe.snapshotAt(7), oldHash=Bun.hash(old.bytes);
  c.append(clusters[2].bytes);c.append(clusters[1].bytes);
  const selected=c.buffer._pipe.snapshotAt(7);
  expect(selected.startTime).toBe(0);
  expect(selected.id).not.toBe(old.id);
  expect(Bun.hash(old.bytes)).toBe(oldHash);
  const reference=join([init,...clusters.slice(0,4).map(group=>group.bytes)]);
  expect(await decode(selected.bytes)).toEqual(await decode(reference));
});

function syntheticCluster(time,toc=0x10,flags=0x80) {
  // One non-laced 40ms Opus packet; payload need not decode for metadata tests.
  return Uint8Array.from([0x1f,0x43,0xb6,0x75,0x8b,0xe7,0x82,time>>8,time&255,
    0xa3,0x85,0x81,0,0,flags,toc]);
}
test('Opus TOC duration, rather than a fixed 20ms, defines contiguous runs',()=>{
  const c=context();c.append(init);c.append(syntheticCluster(0));c.append(syntheticCluster(40));
  expect(c.buffer._pipe.snapshotAt(.06).startTime).toBe(0);
  expect(c.buffer._pipe.snapshotAt(.06).bytes).toBe(c.buffer._pipe.bytes());
  c.append(syntheticCluster(500));
  expect(c.buffer._pipe.snapshotAt(.52).startTime).toBe(.5);
  expect(c.buffer._pipe.snapshotAt(.02).endTime).toBe(.5);
});
test('unsupported lacing or inconsistent pre-skip safely keeps the ordinary decoder route',()=>{
  const c=context();c.append(init);c.append(syntheticCluster(0,0x10,0x82));
  expect(c.buffer._pipe.snapshotAt(7)).toEqual({id:0,startTime:0,endTime:Infinity,bytes:c.buffer._pipe.bytes()});
  const modified=init.slice();
  const opus=modified.findIndex((byte,index)=>byte===79&&new TextDecoder().decode(modified.subarray(index,index+8))==='OpusHead');
  expect(opus).toBeGreaterThan(0);modified[opus+10]^=1;
  const d=context();d.append(modified);d.append(clusters[3].bytes);
  expect(d.buffer._pipe.snapshotAt(7).id).toBe(0);
  expect(d.buffer._pipe.snapshotAt(7).bytes).toBe(d.buffer._pipe.bytes());
});

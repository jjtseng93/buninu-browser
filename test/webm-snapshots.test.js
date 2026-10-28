import { beforeAll, expect, test } from 'bun:test';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';
import { createMediaSourceScope } from '../lib/renderer/media-source.js';
import { createWebMStream, ebmlHeader } from '../lib/media/webm-stream.js';
import { advanceAudio } from '../lib/media/position-audio.js';
import { createWebMAudioSnapshots } from '../lib/media/webm-snapshots.js';

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
  const selected=c.buffer._pipe.snapshotAt(0);
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
  const selected=c.buffer._pipe.snapshotAt(0);
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

test.each([false,true])('continuous %s live Opus reopens with exact samples and at least one second of preroll',async unknown=>{
  const c=context();c.append(init);
  for(const cluster of clusters)c.append(unknown?live(cluster.bytes):cluster.bytes);
  c.source.endOfStream();
  const expected=await decode(fixture), pipe=c.buffer._pipe;
  const initial=pipe.snapshotAt(0);
  for(const target of [3,3.08,3.2,6,6.08,6.2]){
    const snapshot=pipe.snapshotAt(target);
    expect(snapshot.startTime).toBeGreaterThan(0);
    expect(target-snapshot.startTime).toBeGreaterThanOrEqual(1);
    expect(snapshot.id).toBe(initial.id);
    expect(pipe.snapshotAt(target)).toBe(snapshot);
    const pcm=await decode(snapshot.bytes), offset=Math.round((target-snapshot.startTime)*48000);
    const wanted=expected.subarray(Math.round(target*48000),Math.round(target*48000)+9600);
    expect(pcm.subarray(offset,offset+wanted.length)).toEqual(wanted);
  }
});

test.each([false,true])('appending %s live Clusters preserves lazy snapshots and updates the current suffix without another epoch',async unknown=>{
  const c=context();c.append(init);
  for(const cluster of clusters.slice(0,3))c.append(unknown?live(cluster.bytes):cluster.bytes);
  const old=c.buffer._pipe.snapshotAt(5), initial=c.buffer._pipe.snapshotAt(0);
  // Do not read old.bytes until after append: the lazy copy must keep its
  // original packet boundary rather than consult the growing byte pipe.
  for(const cluster of clusters.slice(3))c.append(unknown?live(cluster.bytes):cluster.bytes);
  const fresh=c.buffer._pipe.snapshotAt(5);
  expect(fresh.id).toBe(old.id);expect(fresh.id).toBe(initial.id);
  expect(fresh.startTime).toBe(old.startTime);
  expect(fresh.bytes.length).toBeGreaterThan(old.bytes.length);
  const oldHash=Bun.hash(old.bytes), freshHash=Bun.hash(fresh.bytes);
  expect(c.buffer._pipe.snapshotAt(5)).toBe(fresh);
  expect(Bun.hash(old.bytes)).toBe(oldHash);
  expect(Bun.hash(fresh.bytes)).toBe(freshHash);
  const expected=await decode(fixture), pcm=await decode(old.bytes);
  const offset=Math.round((5-old.startTime)*48000);
  expect(pcm.subarray(offset,offset+9600)).toEqual(expected.subarray(5*48000,5*48000+9600));
});

test('declared SeekPreRoll is honored when greater than the conservative default',()=>{
  const modified=init.slice();
  // The fixture declares 80,000,000ns as a four-byte unsigned SeekPreRoll.
  const at=modified.findIndex((byte,i)=>byte===0x56&&modified[i+1]===0xbb&&modified[i+2]===0x84);
  expect(at).toBeGreaterThan(0);
  new DataView(modified.buffer).setUint32(at+3,4_000_000_000);
  const c=context();c.append(modified);
  for(const cluster of clusters)c.append(cluster.bytes);
  const selected=c.buffer._pipe.snapshotAt(6);
  expect(selected.startTime).toBeGreaterThan(0);
  expect(6-selected.startTime).toBeGreaterThanOrEqual(4);
});

test.each([false,true])('fast reopening inside a sparse %s live run retains that run\'s sample origin',async unknown=>{
  const c=context();c.append(init);c.append(unknown?live(clusters[0].bytes):clusters[0].bytes);
  for(const cluster of clusters.slice(2))c.append(unknown?live(cluster.bytes):cluster.bytes);
  const first=c.buffer._pipe.snapshotAt(4), selected=c.buffer._pipe.snapshotAt(7.2);
  expect(first.startTime).toBe(3.981);
  expect(selected.id).toBe(first.id);
  expect(selected.startTime).toBeGreaterThan(first.startTime);
  expect(7.2-selected.startTime).toBeGreaterThanOrEqual(1);
  const expected=await decode(join([init,...clusters.slice(2).map(e=>e.bytes)]));
  const pcm=await decode(selected.bytes), start=Math.round((7.2-first.startTime)*48000);
  const skip=Math.round(7.2*48000)-Math.round(selected.startTime*48000);
  expect(pcm.subarray(skip,skip+9600)).toEqual(expected.subarray(start,start+9600));
});

test('timestamp drift beyond rounding tolerance declines fast trimming without inventing PCM time',()=>{
  const c=context();c.append(init);
  for(let i=0;i<100;i++)c.append(syntheticCluster(i*41));
  // Each timestamp is within a one-tick adjacency tolerance, but cumulatively
  // the packets no longer agree with a continuous exact-sample clock.
  const selected=c.buffer._pipe.snapshotAt(3);
  expect(selected.startTime).toBe(0);
  expect(selected.bytes).toBe(c.buffer._pipe.bytes());
});

test('a fractional initial sample is rounded once before adding exact packet sample counts',()=>{
  const modified=init.slice();
  const at=modified.findIndex((byte,i)=>byte===0x2a&&modified[i+1]===0xd7&&modified[i+2]===0xb1&&modified[i+3]===0x83);
  expect(at).toBeGreaterThan(0);
  modified.set([0,0x7a,0x12],at+4); // TimestampScale=31250ns; timecode1 is 1.5 samples.
  const c=context();c.append(modified);
  for(let i=0;i<40;i++)c.append(syntheticCluster(1+i*1280)); // 40ms Opus packets.
  const first=c.buffer._pipe.snapshotAt(0), selected=c.buffer._pipe.snapshotAt(1.05);
  expect(first.startTime).toBe(.00003125);
  expect(selected.startTime).toBeGreaterThan(first.startTime);
  expect(Math.round(selected.startTime*48000)).toBe(Math.round(first.startTime*48000)+1920);
});

test('audio EOF refill uses the fast prefix and keeps the full stream sample cursor',async()=>{
  const c=context();c.append(init);
  for(const cluster of clusters.slice(0,3))c.append(cluster.bytes);
  const pipe=c.buffer._pipe, expected=await decode(fixture);
  let sound, opens=0, active=true, reopenedAt;
  const open=async time=>{
    const snapshot=pipe.snapshotAt(time),decoder=await wasmpeg.decodeAudio(snapshot.bytes,{format:'webm'});
    sound?.decoder.close();opens++;
    if(opens>1)reopenedAt=snapshot.startTime;
    sound={...snapshot,decoder,position:Math.round(snapshot.startTime*decoder.sampleRate),pending:null,
      pipe,openedGeneration:pipe.generation,snapshotId:snapshot.id};
    return true;
  };
  await open(0);
  let timer;
  const append=setTimeout(()=>{for(const cluster of clusters.slice(3))c.append(cluster.bytes);},20);
  try{
    const reached=await Promise.race([
      advanceAudio(()=>sound,6.5,{needsMore:()=>true,active:()=>active,reopen:()=>open(6.5)}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('audio refill stalled')),1000);}),
    ]);
    expect(reached).toBe(true);expect(opens).toBe(2);expect(reopenedAt).toBeGreaterThan(0);
    expect(sound.position).toBe(6.5*48000);
    const pending=sound.pending??sound.decoder.nextSamples();
    expect(pending).toEqual(expected.subarray(sound.position,sound.position+pending.length));
  }finally{clearTimeout(timer);clearTimeout(append);active=false;pipe.finish();sound.decoder.close();}
});

test('a lazy fast snapshot retains its own run when later arrivals fill an earlier hole',async()=>{
  const c=context();c.append(init);
  for(const index of [0,2,3,4])c.append(clusters[index].bytes);
  const old=c.buffer._pipe.snapshotAt(7.2), oldStart=old.startTime;
  c.append(clusters[1].bytes);
  const fresh=c.buffer._pipe.snapshotAt(7.2);
  expect(fresh.id).not.toBe(old.id);
  expect(old.startTime).toBe(oldStart);
  const expected=await decode(join([init,...clusters.slice(2).map(e=>e.bytes)]));
  const pcm=await decode(old.bytes), skip=Math.round(7.2*48000)-Math.round(old.startTime*48000);
  const offset=Math.round((7.2-3.981)*48000);
  expect(pcm.subarray(skip,skip+9600)).toEqual(expected.subarray(offset,offset+9600));
});

function ebmlElement(id, payload, width = 4) {
  const size = new Uint8Array(width);
  let value = payload.length;
  for (let i = width - 1; i >= 0; i--) { size[i] = value & 255; value = Math.floor(value / 256); }
  size[0] |= 1 << (8 - width);
  return join([Uint8Array.from(id), size, payload]);
}
function childElements(bytes) {
  const parent = ebmlHeader(bytes), result = [];
  for (let at = parent.length; at < bytes.length;) {
    const head = ebmlHeader(bytes, at), data = at + head.length, end = data + head.size;
    result.push({id:head.id, at, data, end});
    at = end;
  }
  return result;
}
function longFiniteCluster() {
  const parts = [Uint8Array.from([0xe7,0x81,0])];
  // Merge the existing real eight-second fixture into one finite Cluster.
  // Only Block relative timestamps change; encoded Opus packets stay intact.
  for (const cluster of clusters) {
    const children = childElements(cluster.bytes), timestamp = children.find(item => item.id === 0xe7);
    let origin = 0;
    for (let at = timestamp.data; at < timestamp.end; at++) origin = origin * 256 + cluster.bytes[at];
    for (const child of children.filter(item => item.id === 0xa3 || item.id === 0xa0)) {
      const copy = cluster.bytes.slice(child.at, child.end);
      const block = child.id === 0xa3 ? {data:ebmlHeader(copy).length} : childElements(copy).find(item => item.id === 0xa1);
      let trackBytes = 1, mask = 0x80;
      while (!(copy[block.data] & mask)) { trackBytes++; mask >>= 1; }
      const view = new DataView(copy.buffer, copy.byteOffset + block.data + trackBytes, 2);
      view.setInt16(0, view.getInt16(0) + origin);
      parts.push(copy);
    }
  }
  return ebmlElement([0x1f,0x43,0xb6,0x75], join(parts));
}

test('one long finite Opus Cluster reopens at packet granularity with exact PCM and unchanged preroll', async () => {
  const cluster = longFiniteCluster(), original = cluster.slice(), c = context();
  c.append(init); c.append(cluster); c.source.endOfStream();
  const expected = await decode(fixture), pipe = c.buffer._pipe;
  expect(await decode(pipe.snapshotAt(0).bytes)).toEqual(expected);
  for (const target of [3, 6, 6.08, 7.2]) {
    const snapshot = pipe.snapshotAt(target), prefix = target - snapshot.startTime;
    expect(prefix).toBeGreaterThanOrEqual(1);
    expect(prefix).toBeLessThanOrEqual(1.021);
    const pcm = await decode(snapshot.bytes);
    const skip = Math.round(target * 48000) - Math.round(snapshot.startTime * 48000);
    expect(pcm.subarray(skip, skip + 9600)).toEqual(expected.subarray(Math.round(target * 48000), Math.round(target * 48000) + 9600));
  }
  expect(cluster).toEqual(original);
});

test.each([1, 2, 4, 8])('finite Cluster size field width %s becomes a valid unknown-size prefix without mutating input', width => {
  const c = context(), originals = []; c.append(init);
  for (let i = 0; i < 40; i++) {
    const ordinary = syntheticCluster(i * 40);
    const bytes = ebmlElement([0x1f,0x43,0xb6,0x75], ordinary.subarray(ebmlHeader(ordinary).length), width);
    originals.push([bytes, bytes.slice()]); c.append(bytes);
  }
  const selected = c.buffer._pipe.snapshotAt(1.4);
  expect(selected.startTime).toBeGreaterThan(0);
  const emitted = createWebMStream().append(selected.bytes), blocks = emitted.filter(item => item.cluster);
  expect(blocks.length).toBeGreaterThan(0);
  expect(ebmlHeader(blocks[0].cluster.prefix[0])).toMatchObject({size:Infinity, length:4 + width});
  expect(blocks.every(item => item.bytes[0] === 0xa3)).toBe(true);
  for (const [bytes, original] of originals) expect(bytes).toEqual(original);
});

test('finite Cluster checksums, positional, encrypted and unknown metadata retain ordinary decoder bytes', () => {
  const base = syntheticCluster(0), body = base.subarray(ebmlHeader(base).length);
  for (const metadata of [[0xbf,0x84,0,0,0,0], [0xa7,0x81,0], [0xab,0x81,0], [0xaf,0x81,0], [0x80,0x80]]) {
    const c = context(); c.append(init);
    c.append(ebmlElement([0x1f,0x43,0xb6,0x75], join([body.subarray(0,4), Uint8Array.from(metadata), body.subarray(4)])));
    const selected = c.buffer._pipe.snapshotAt(5);
    expect(selected.id).toBe(0);
    expect(selected.bytes).toBe(c.buffer._pipe.bytes());
  }
});

test('finite BlockGroup, leading Void, truncation and track encodings preserve conservative boundaries', async () => {
  const simple = syntheticCluster(0), body = simple.subarray(ebmlHeader(simple).length);
  const group = ebmlElement([0xa0], ebmlElement([0xa1], body.subarray(6), 1), 1);
  const c = context(); c.append(init);
  for (let i = 0; i < 40; i++) {
    const timestamp = Uint8Array.from([0xe7,0x82,i*40>>8,i*40&255]);
    c.append(ebmlElement([0x1f,0x43,0xb6,0x75], join([Uint8Array.from([0xec,0x81,0]), timestamp, group])));
  }
  const selected = c.buffer._pipe.snapshotAt(1.4);
  const blocks = createWebMStream().append(selected.bytes).filter(item => item.cluster);
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every(item => item.bytes[0] === 0xa0)).toBe(true);
  expect(blocks[0].cluster.prefix.some(bytes => bytes[0] === 0xec)).toBe(true);

  const index = createWebMAudioSnapshots();
  for (const element of createWebMStream().append(init)) index.append(element);
  index.append({id:0x1f43b675, bytes:simple.subarray(0,simple.length - 1)});
  expect(index.at(5,()=>simple)).toMatchObject({id:0, startTime:0, bytes:simple});

  const trackElement = elements.find(item => item.id === 0x1654ae6b);
  const track = childElements(trackElement.bytes)[0];
  const encodedTrack = ebmlElement([0xae], join([trackElement.bytes.subarray(track.data,track.end), Uint8Array.from([0x6d,0x80,0x80])]));
  const encodedTracks = ebmlElement([0x16,0x54,0xae,0x6b], encodedTrack), encrypted = createWebMAudioSnapshots();
  for (const element of createWebMStream().append(init)) encrypted.append(element.id === 0x1654ae6b ? {id:element.id,bytes:encodedTracks} : element);
  encrypted.append({id:0x1f43b675,bytes:simple});
  expect(encrypted.at(5,()=>simple)).toMatchObject({id:0,startTime:0,bytes:simple});
});

test('finite packet cuts retain a large immutable metadata prefix only once in the selected output', () => {
  const padding = Uint8Array.from({length:4000*2},(_,i)=>i%2?0x80:0xec);
  const parts = [padding, Uint8Array.from([0xe7,0x81,0])];
  for(let i=0;i<1000;i++) {
    // One 20ms Opus packet per Block; the payload is metadata-only here.
    parts.push(Uint8Array.from([0xa3,0x85,0x81,i*20>>8,i*20&255,0x80,0x08]));
  }
  const bytes = ebmlElement([0x1f,0x43,0xb6,0x75],join(parts)), original=bytes.slice(), c=context();
  c.append(init);c.append(bytes);
  const selected=c.buffer._pipe.snapshotAt(18), parsed=createWebMStream().append(selected.bytes);
  const blocks=parsed.filter(item=>item.cluster);
  expect(selected.startTime).toBe(17);
  expect(blocks.length).toBe(150);
  expect(blocks[0].cluster.prefix.length).toBe(4002);
  expect(selected.bytes.length).toBeLessThan(init.length+padding.length+7*151+32);
  expect(bytes).toEqual(original);
});

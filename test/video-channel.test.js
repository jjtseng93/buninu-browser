import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VideoChannel,startVideoChannel} from '../lib/renderer/video-channel.js';

test('video channel rejects late frames and reports from stopped/replaced presentations',()=>{
  let listener,changed=0;const reports=[],sent=[];
  const channel=new VideoChannel({addEventListener(type,f){if(type==='message')listener=f;},postMessage(m){sent.push(m);}},()=>changed++,r=>reports.push(r));
  channel.open({id:1});channel.open({id:2});
  listener({data:{type:'frame',id:1,delivery:1,frame:{time:1}}});
  listener({data:{type:'report',report:{id:1,end:2}}});
  expect(changed).toBe(0);expect(reports).toHaveLength(0);
  listener({data:{type:'frame',id:2,delivery:2,frame:{time:3}}});
  expect(channel.frame.time).toBe(3);expect(changed).toBe(1);
  channel.stop(1);expect(channel.config.id).toBe(2);
  channel.stop(2);listener({data:{type:'frame',id:2,delivery:3,frame:{time:4}}});
  expect(channel.frame).toBeNull();expect(changed).toBe(1);
  expect(sent.filter(m=>m.type==='frame-ack')).toEqual([
    {type:'frame-ack',id:1,delivery:1},
    {type:'frame-ack',id:2,delivery:2},
    {type:'frame-ack',id:2,delivery:3},
  ]);
});

test('frame notification failures still ACK and a failed transport reports fallback without more sends',()=>{
  let listener,failed=false,terminated=0;const sent=[],reports=[];
  const worker={addEventListener(type,f){if(type==='message')listener=f;},postMessage(m){
    if(failed)throw Error('worker unavailable');
    sent.push(m);
  },terminate(){terminated++;}};
  const channel=new VideoChannel(worker,()=>{throw Error('presentation callback');},r=>reports.push(r));
  channel.open({id:7});
  expect(()=>listener({data:{type:'frame',id:7,delivery:1,frame:{time:0}}})).toThrow('presentation callback');
  expect(sent.at(-1)).toEqual({type:'frame-ack',id:7,delivery:1});
  failed=true;channel.timing(9,.5);
  expect(reports).toEqual([{id:7,error:'worker unavailable'}]);
  expect(channel.frame).toBeNull();expect(channel.config).toBeNull();
  channel.open({id:8});channel.bind(8,9,0,0);channel.stop();channel.timing(9,1);
  listener({data:{type:'frame',id:8,delivery:2,frame:{time:1}}});
  expect(reports.at(-1)).toEqual({id:8,error:'worker unavailable'});
  expect(channel.frame).toBeNull();expect(terminated).toBe(1);
  expect(sent).toHaveLength(2);
});

test('worker failure is latched before terminate synchronously emits close',()=>{
  const listeners=new Map(),reports=[];let terminated=0;
  const worker={addEventListener(type,listener){listeners.set(type,listener);},postMessage(){},
    terminate(){terminated++;listeners.get('close')({code:0});}};
  const channel=new VideoChannel(worker,()=>{},report=>reports.push(report));
  channel.open({id:9});
  listeners.get('error')(new Error(''));
  listeners.get('close')({code:0});
  listeners.get('error')(new Error('later'));
  expect(reports).toEqual([{id:9,error:'Video worker failed'}]);
  expect(terminated).toBe(1);
  expect(channel.config).toBeNull();expect(channel.frame).toBeNull();
});

// Use the real Bun Worker lifecycle with a tiny file, avoiding decoder/WASM
// startup and page realms' scoped Blob URL hooks. Restore the constructor
// before the first async continuation; each caller removes its own directory.
function startLifecycleWorker(source,changed,report) {
  const Original=globalThis.Worker;
  const directory=mkdtempSync(join(tmpdir(),'buninu-video-lifecycle-'));
  const path=join(directory,'worker.js');
  let worker,starting;
  const dispose=()=>{worker?.terminate();rmSync(directory,{recursive:true,force:true});};
  try {
    writeFileSync(path,source);
    globalThis.Worker=class extends Original {constructor(){super(path);worker=this;}};
    try {starting=startVideoChannel(changed,report);}
    finally {globalThis.Worker=Original;}
    return {worker,starting,dispose};
  } catch(error) {dispose();throw error;}
}

test('closing before ready rejects promptly instead of waiting for the startup timeout',async()=>{
  const reports=[];
  const fixture=startLifecycleWorker('process.exit(7)',()=>{},report=>reports.push(report));
  let timer;
  try {
    const result=await Promise.race([
      fixture.starting.then(()=>null,error=>error.message),
      new Promise(resolve=>{timer=setTimeout(()=>resolve('startup was not rejected'),2000);}),
    ]);
    expect(result).toBe('Video worker closed (7)');
    expect(reports).toEqual([]);
  }finally{clearTimeout(timer);fixture.dispose();}
},5000);

test('closing after ready clears stale pixels and reports fallback exactly once',async()=>{
  const reports=[];let changed=0;
  const fixture=startLifecycleWorker(`self.onmessage=({data})=>{
    if(data.type==='open'){
      postMessage({type:'frame',id:data.config.id,delivery:1,
        frame:{time:0,width:1,height:1,pixels:new Uint8Array([1,2,3,255])}});
      setTimeout(()=>process.exit(0),5);
    }
  };postMessage({type:'ready'});`,()=>changed++,report=>reports.push(report));
  try {
    const channel=await fixture.starting;
    channel.open({id:10});
    for(let i=0;i<100&&!reports.length;i++)await Bun.sleep(10);
    expect(changed).toBe(1);
    expect(reports).toEqual([{id:10,error:'Video worker closed (0)'}]);
    expect(channel.config).toBeNull();expect(channel.frame).toBeNull();
    channel.timing(1,1);channel.fail(new Error('later'));fixture.worker.terminate();
    await Bun.sleep(10);
    expect(reports).toHaveLength(1);
  }finally{fixture.dispose();}
},5000);

test('independent decoder transfers live pixels and retains measured-audio gating',async()=>{
  const reports=[];const channel=await startVideoChannel(()=>{},r=>reports.push(r));
  try {
    const bytes=await Bun.file(new URL('./fixtures/long-video.mp4',import.meta.url)).bytes();
    channel.timing(4,0);
    channel.open({id:10,bytes,time:0,hasAudio:true,audioId:4,audioStart:0});
    for(let i=0;i<100&&!channel.frame;i++)await Bun.sleep(20);
    expect(channel.frame?.pixels.byteLength).toBeGreaterThan(0);
    expect(channel.frame.time).toBe(0);
    const first=channel.frame;
    await Bun.sleep(100);expect(channel.frame).toBe(first);
    channel.timing(4,.5);
    for(let i=0;i<100&&(channel.frame?.time??0)<.4;i++)await Bun.sleep(20);
    expect(channel.frame.time).toBeGreaterThanOrEqual(.4);
    expect(channel.frame.pixels.byteLength).toBe(channel.frame.width*channel.frame.height*4);
    expect(first.pixels.byteLength).toBe(first.width*first.height*4);
    expect(reports.some(r=>r.error)).toBe(false);
  }finally{channel.stop();channel.worker.terminate();}
},15000);

test('decoder sends only its latest pending frame and validates ACKs across stop and reopen',async()=>{
  const worker=new Worker(new URL('../lib/renderer/video-worker.js',import.meta.url).href);
  const frames=[],reports=[];let ready=false,error=null;
  worker.addEventListener('message',({data})=>{
    if(data.type==='ready')ready=true;
    else if(data.type==='frame')frames.push(data);
    else if(data.type==='report')reports.push(data.report);
  });
  worker.addEventListener('error',event=>{error=event;});
  async function until(predicate){
    for(let i=0;i<200&&!predicate()&&!error;i++)await Bun.sleep(10);
    if(error)throw error;
    expect(predicate()).toBe(true);
  }
  const ack=frame=>worker.postMessage({type:'frame-ack',id:frame.id,delivery:frame.delivery});
  try {
    await until(()=>ready);
    const bytes=await Bun.file(new URL('./fixtures/long-video.mp4',import.meta.url)).bytes();
    const open=(id,audioId)=>{
      worker.postMessage({type:'timing',id:audioId,seconds:0});
      worker.postMessage({type:'open',config:{id,bytes,time:0,hasAudio:true,audioId,audioStart:0}});
    };
    open(1,11);
    await until(()=>frames.length===1);
    worker.postMessage({type:'timing',id:11,seconds:1});
    await until(()=>reports.some(r=>r.id===1&&r.time>=1));
    expect(frames).toHaveLength(1);
    ack({...frames[0],id:99});ack({...frames[0],delivery:99});
    await Bun.sleep(30);expect(frames).toHaveLength(1);
    ack(frames[0]);await until(()=>frames.length===2);
    expect(frames[1].frame.time).toBeGreaterThanOrEqual(1);
    // Reopening retains the outstanding delivery, while discarding pending
    // pixels from the previous generation. Its valid ACK unlocks the new one.
    open(2,12);
    await until(()=>reports.some(r=>r.id===2&&r.time===0));
    ack(frames[0]);await Bun.sleep(30);expect(frames).toHaveLength(2);
    ack(frames[1]);await until(()=>frames.length===3);
    expect(frames[2].id).toBe(2);expect(frames[2].frame.time).toBe(0);
    worker.postMessage({type:'timing',id:12,seconds:1});
    await until(()=>reports.some(r=>r.id===2&&r.time>=1));
    worker.postMessage({type:'stop',id:2});open(3,13);
    await until(()=>reports.some(r=>r.id===3&&r.time===0));
    ack(frames[1]);await Bun.sleep(30);expect(frames).toHaveLength(3);
    ack(frames[2]);await until(()=>frames.length===4);
    expect(frames[3].id).toBe(3);expect(frames[3].frame.time).toBe(0);
    expect(frames[3].delivery).toBeGreaterThan(frames[2].delivery);
    expect(reports.some(r=>r.error)).toBe(false);
    for(const {frame}of frames)expect(frame.pixels.byteLength).toBe(frame.width*frame.height*4);
  }finally{worker.terminate();}
},15000);

test('same-presentation extension preserves the last frame and filters replaced sessions', () => {
  const sent = [];
  const channel = new VideoChannel({ addEventListener() {}, postMessage(message) { sent.push(message); } }, () => {}, () => {});
  channel.open({ id: 7 });
  const frame = channel.frame = { time: 2 };
  channel.extend({ id: 6, revision: 0, generation: 2 });
  expect(sent).toHaveLength(1);
  channel.extend({ id: 7, revision: 0, generation: 2 });
  expect(sent.at(-1)).toEqual({ type: 'extend', id: 7, revision: 0, generation: 2 });
  expect(channel.frame).toBe(frame);
  channel.stop();
});

test('real fMP4 snapshot extension preserves transfer ownership and sequential pixels across EOF', async () => {
  const { default: wasmpeg } = await import('../vendor/wasmpeg/src/js/index.js');
  await wasmpeg.load();
  const bytes = await Bun.file(new URL('./fixtures/mse-switch-large.mp4', import.meta.url)).bytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = 0;
  while (end < bytes.length) {
    const size = view.getUint32(end);
    const type = String.fromCharCode(...bytes.subarray(end + 4, end + 8));
    end += size;
    if (type === 'mdat') break;
  }
  const oracle = await wasmpeg.decode(bytes);
  const expected = [];
  try {
    let pixels;
    while ((pixels = oracle.nextFrame(oracle.width, oracle.height))) expected.push(Bun.hash(pixels));
  } finally { oracle.close(); }
  const reports = [], frames = [];
  const channel = await startVideoChannel(() => {
    const { time, pixels } = channel.frame;
    frames.push({ time, pixels, hash: Bun.hash(pixels) });
  }, report => reports.push(report));
  const until = async predicate => {
    for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  };
  try {
    channel.timing(9, 0);
    channel.open({ id: 30, bytes: bytes.slice(0, end), snapshotId: 'video-epoch', generation: 1,
      time: 0, hasAudio: true, audioId: 9, audioStart: 0 });
    await until(() => frames.length > 0);
    channel.timing(9, 1.3);
    await until(() => reports.some(report => Number.isFinite(report.exhaustedAt)));
    const exhausted = reports.find(report => Number.isFinite(report.exhaustedAt));
    expect(exhausted.exhaustedAt).toBeCloseTo(2, 6);
    const previous = channel.frame;
    channel.extend({ id: 30, revision: 0, generation: 2, snapshotId: 'video-epoch',
      bytes, boundary: exhausted.exhaustedAt });
    expect(channel.frame).toBe(previous);
    await until(() => reports.some(report => report.continued === 2));
    for (let i = 14; i <= 60; i++) {
      channel.timing(9, i / 10);
      await Bun.sleep(15);
    }
    await until(() => reports.some(report => report.end >= 5.9));
    expect(reports.some(report => report.error || report.continuationError)).toBe(false);
    expect(reports.filter(report => report.continued).map(report => report.revision)).toEqual([1]);
    expect(new Set(frames.map(frame => Math.round(frame.time * 10))).size).toBe(frames.length);
    expect(frames.some(frame => Math.abs(frame.time - 2) < 1e-6)).toBe(true);
    for (const frame of frames) {
      expect(frame.pixels.byteLength).toBe(128 * 96 * 4);
      expect(frame.hash).toBe(expected[Math.round(frame.time * 10)]);
    }
  } finally { channel.stop(); channel.worker.terminate(); }
}, 15000);

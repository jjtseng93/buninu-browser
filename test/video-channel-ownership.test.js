import {test,expect} from 'bun:test';
import {VideoChannel} from '../lib/renderer/video-channel.js';
import {captureVideoViewport,compositeVideo} from '../lib/renderer/video-presentation.js';
import {encodeImage,rawFrame} from '../lib/paint/frame.js';

const frame=(seed=4,buffer=new ArrayBuffer(16),offset=0,length=16)=>({time:seed,width:2,height:2,pixels:new Uint8Array(buffer,offset,length).fill(seed)});
function fixture(changed=()=>{},own=true){
 const listeners={},sent=[],reports=[];let channel;
 const worker={addEventListener(t,f){listeners[t]=f},postMessage(m){sent.push(m)},terminate(){}};
 channel=new VideoChannel(worker,()=>changed(channel),r=>reports.push(r),{releaseRetiredFrames:own});channel.open({id:1});
 return{channel,sent,reports,deliver(f,id=1){listeners.message({data:{type:'frame',id,delivery:sent.length+1,frame:f}})},listeners};
}
test('default channel preserves retired snapshots while private opt-in reclaims full buffers',()=>{
 for(const own of [false,true]){
  const f=fixture(()=>{},own),first=frame(),next=frame(7);f.deliver(first);f.deliver(next);
  expect(first.pixels.byteLength).toBe(own?0:16);expect([...f.channel.frame.pixels]).toEqual(Array(16).fill(7));
  f.channel.stop();expect(next.pixels.byteLength).toBe(own?0:16);
 }
});
test('partial and shared buffers remain valid; duplicate and aliased active buffer stays alive',()=>{
 const f=fixture();
 for(const buffer of [new ArrayBuffer(32),new SharedArrayBuffer(16)]){
  const old=frame(2,buffer,buffer instanceof SharedArrayBuffer?0:8);f.deliver(old);f.deliver(frame(3));expect(old.pixels.byteLength).toBe(16);
 }
 const same=frame(5);f.deliver(same);f.deliver(same);expect(same.pixels.byteLength).toBe(16);
 f.deliver({...same,pixels:new Uint8Array(same.pixels.buffer)});expect(same.pixels.byteLength).toBe(16);
 f.deliver(frame(9));expect(same.pixels.byteLength).toBe(0);
});
test('all lifecycle paths release only replaced private snapshots; stale generations still ACK',()=>{
 for(const operation of ['stop','open','fail']){
  const f=fixture(),old=frame();f.deliver(old);
  f.channel.stop(99);expect(old.pixels.byteLength).toBe(16);
  if(operation==='stop')f.channel.stop();else if(operation==='open')f.channel.open({id:2});else f.channel.fail(Error('intentional'));
  expect(old.pixels.byteLength).toBe(0);expect(f.channel.frame).toBeNull();
 }
 const f=fixture(),old=frame();f.deliver(old);f.deliver(frame(2),99);expect(old.pixels.byteLength).toBe(16);expect(f.sent.at(-1).type).toBe('frame-ack');
});
test('nested notification and stop/open keep borrowed bytes through the outer callback',()=>{
 let first,second,depth=0;
 const f=fixture(channel=>{
  if(depth++)return;
  const borrowed=channel.frame;
  second=frame(8);f.deliver(second);
  expect(borrowed.pixels.byteLength).toBe(16);channel.stop();channel.open({id:2});
  expect(second.pixels.byteLength).toBe(16);expect(borrowed.pixels.byteLength).toBe(16);
 });
 first=frame();f.deliver(first);expect(first.pixels.byteLength).toBe(0);expect(second.pixels.byteLength).toBe(0);
 expect(f.sent.filter(x=>x.type==='frame-ack')).toHaveLength(2);
});
test('nested reentry returning an earlier buffer does not detach the new current frame',()=>{
 let old,depth=0;
 const f=fixture(()=>{if(depth++===1)f.deliver(old)});
 old=frame(4);f.deliver(old);const next=frame(5);f.deliver(next);
 expect(f.channel.frame).toBe(old);expect(old.pixels.byteLength).toBe(16);expect(next.pixels.byteLength).toBe(0);
});
test('notification throws still release retired pixels and ACK current delivery',()=>{
 let throws=false;const f=fixture(()=>{if(throws)throw Error('callback')});
 const old=frame(),next=frame(7);f.deliver(old);throws=true;expect(()=>f.deliver(next)).toThrow('callback');
 expect(old.pixels.byteLength).toBe(0);expect(next.pixels.byteLength).toBe(16);expect(f.sent.at(-1).type).toBe('frame-ack');
});
test('raw and PNG captures own pixels while decoded frames retire during asynchronous encode',async()=>{
 const base=new Uint8Array(new SharedArrayBuffer(16)),mask=new Uint8Array(new SharedArrayBuffer(16));
 for(let i=0;i<16;i+=4){base[i+3]=255;mask.set([255,255,255,0],i)}
 const tile={x:0,y:0,width:2,height:2,scale:1,pixelWidth:2,pixelHeight:2,pixels:base,videoLayer:{base,mask,rect:{x:0,y:0,width:2,height:2}}};
 const f=fixture(),first=frame(117);f.deliver(first);
 const raw=captureVideoViewport(tile,first,0,0,2,2,undefined,'bgra'),rendered=compositeVideo(tile,first);
 const expectedRaw=new Uint8Array(raw.pixels),expectedPng=await encodeImage(rendered.pixels,2,2);
 const pending=encodeImage(rendered.pixels,2,2); // Real async Bun.Image borrows an independent BMP.
 f.deliver(frame(39));expect(first.pixels.byteLength).toBe(0);
 const result=rawFrame(raw.pixels,2,2,'bgra',{inputFormat:'bgra',takeOwnership:true});
 expect(result.pixels).toEqual(expectedRaw);expect(await pending).toEqual(expectedPng);
 result.pixels.buffer.transfer(0);rendered.pixels.buffer.transfer(0);expect(f.channel.frame.pixels.byteLength).toBe(16);
});

test('real compositor captures remain valid across continuing decoder replacement',async()=>{
 const {RendererHost}=await import('../lib/renderer/host.js');
 const host=new RendererHost({timeout:20000,fetch:async()=>new Response(Bun.file(new URL('./fixtures/long-video.mp4',import.meta.url)),{headers:{'content-type':'video/mp4'}})});
 try{
  await host.start();await host.call('resize',640,480,1);
  await host.call('loadDocument',{url:'https://page.test/',contentType:'text/html',source:'<body style="margin:0"><video id="v" width="640" height="480" src="/movie.mp4"></video>'});
  await host.call('whenLoaded');await host.call('evaluate','document.getElementById("v").play()');await Bun.sleep(350);
  const pending=[];
  for(let n=0;n<3;n++){
   pending.push(host.composite('screenshot',{format:'png'}),host.composite('screenshot',{format:n%2?'bgra':'rgba'}).then(async data=>{const frame=JSON.parse(data);return {...frame,pixels:await Bun.file(frame.path).bytes()}}));
   await Bun.sleep(35);
  }
  const captures=await Promise.all(pending),hashes=captures.map(c=>Bun.hash(typeof c==='string'?c:c.pixels));
  for(const c of captures)if(typeof c==='string')expect((await new Bun.Image(Buffer.from(c,'base64')).metadata()).width).toBe(640);
  else{expect(c.width).toBe(640);expect(c.height).toBe(480);expect(c.pixels.length).toBe(640*480*4)}
  await Bun.sleep(200);expect(captures.map(c=>Bun.hash(typeof c==='string'?c:c.pixels))).toEqual(hashes);
 }finally{host.close()}
},20000);

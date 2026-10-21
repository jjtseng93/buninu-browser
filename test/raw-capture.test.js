import {test,expect} from 'bun:test';
import {readFileSync,existsSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {RendererHost} from '../lib/renderer/host.js';
import {PacketReader,encodePacket,listenCompositor,connectCompositor} from '../lib/renderer/compositor-channel.js';
import {RawFrames} from '../lib/paint/raw-frames.js';
import CanvasKitInit from '../usr/lib/canvaskit/canvaskit.js';
const kit=CanvasKitInit({wasmBinary:readFileSync(new URL('../usr/lib/canvaskit/canvaskit.wasm',import.meta.url))});

test('binary channel handles fragmented packets, rejects oversized input and authenticates peers',async()=>{
 const results=[];const reader=new PacketReader((message,pixels)=>results.push([message,[...pixels]]));
 const bytes=Buffer.concat([encodePacket({id:1},Uint8Array.of(1,2,3)),encodePacket({id:2})]);
 for(let i=0;i<bytes.length;i++)reader.push(bytes.subarray(i,i+1));
 expect(results).toEqual([[{id:1},[1,2,3]],[{id:2},[]]]);
 const header=Buffer.alloc(8);header.writeUInt32LE(0xffffffff,0);
 expect(()=>new PacketReader(()=>{}).push(header)).toThrow('size');
 let reply;const got=new Promise(resolve=>reply=resolve);
 const server=await listenCompositor((message,pixels)=>{server.send({id:message.id,length:pixels.length});},()=>{});
 let peer;
 try{
  await expect(connectCompositor({...server.endpoint,token:'wrong'},()=>{},()=>{})).rejects.toThrow();
  peer=await connectCompositor(server.endpoint,message=>reply(message),()=>{});
  peer.send({id:8},new Uint8Array(1024));expect(await got).toEqual({id:8,length:1024});
 }finally{peer?.close();server.close();}
});

test('raw file owner rejects malformed input and bounds unconsumed frames',()=>{
 const store=new RawFrames();let path;
 try{
  expect(()=>store.write(new Uint8Array(3),1,1,'rgba')).toThrow('Invalid');
  for(let i=0;i<16;i++)path=JSON.parse(store.write(new Uint8Array(4),1,1,'rgba')).path;
  expect(()=>store.write(new Uint8Array(4),1,1,'rgba')).toThrow('stalled');
 }finally{store.close();}
 expect(existsSync(dirname(path))).toBe(false);
});

for(const compositor of [true,false])test(`raw screenshots match PNG and stay fresh after consumer deletion (compositor=${compositor})`,async()=>{
 const host=new RendererHost({compositor});let directory;
 try{
  await host.start();await host.call('resize',32,24,1);
  await host.call('loadDocument',{url:'https://page.test/',source:'<body style="margin:0;background:rgb(211,73,19)">',contentType:'text/html'});
  await host.call('whenLoaded');
  const png=await host.composite('screenshot',{format:'png'});
  const CK=await kit;const image=CK.MakeImageFromEncoded(Buffer.from(png,'base64'));
  const reference=image.readPixels(0,0,{width:32,height:24,colorType:CK.ColorType.RGBA_8888,alphaType:CK.AlphaType.Unpremul,colorSpace:CK.ColorSpace.SRGB});image.delete();
  for(const format of ['rgba','bgra']){
   const frame=JSON.parse(await host.composite('screenshot',{format}));directory=dirname(frame.path);
   const pixels=readFileSync(frame.path);expect(pixels.length).toBe(32*24*4);
   if(format==='bgra')for(let i=0;i<pixels.length;i+=4){const r=pixels[i];pixels[i]=pixels[i+2];pixels[i+2]=r;}
   expect([...pixels]).toEqual([...reference]);unlinkSync(frame.path);
   const next=JSON.parse(await host.composite('screenshot',{format}));expect(next.path).not.toBe(frame.path);expect(existsSync(next.path)).toBe(true);unlinkSync(next.path);
  }
  if(compositor){
   const busy=host.call('evaluate',"(()=>{const end=Date.now()+1800;while(Date.now()<end);return 1})()");await Bun.sleep(150);
   const start=performance.now();const raw=JSON.parse(await host.composite('screenshot',{format:'bgra'}));
   expect(performance.now()-start).toBeLessThan(1400);unlinkSync(raw.path);await busy;
  }
 }finally{host.close();}
 expect(existsSync(directory)).toBe(false);
},20000);

test('normal CDP routes raw requests to the controller without changing standard screenshots',async()=>{
 const {createBrowser}=await import('../lib/headless-shell.js');
 const {CdpServer}=await import('../lib/cdp-server.js');
 const {CDP}=await import('../tools/browser-lab.js');
 const browser=await createBrowser({spareRenderer:false});
 const server=CdpServer.create(browser.context).listen(0,'127.0.0.1');
 const cdp=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
 let directory;
 try{
  await cdp.ready;const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
  const {data}=await cdp.send('Page.captureScreenshot',{format:'bgra'});
  const frame=JSON.parse(data);directory=dirname(frame.path);
  expect(frame).toMatchObject({version:1,transport:'file',format:'bgra'});expect(existsSync(frame.path)).toBe(true);
  const png=await cdp.send('Page.captureScreenshot',{format:'png'});
  expect([...Buffer.from(png.data,'base64').subarray(0,4)]).toEqual([137,80,78,71]);
 }finally{cdp.close();server.stop(true);browser.close();}
 expect(existsSync(directory)).toBe(false);
},20000);

test('closing during listener startup rejects promptly and a new start remains usable',async()=>{
 const host=new RendererHost();
 const pending=host.start();host.close();
 await expect(pending).rejects.toThrow('closed');
 try{await host.start();expect(host.pid).toBeGreaterThan(0);}finally{host.close();}
},15000);

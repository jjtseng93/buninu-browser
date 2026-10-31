import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {CdpServer} from '../lib/cdp-server.js';
import {CDP} from '../tools/browser-lab.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=','base64');
test('image decode waits for real pixels, handles detached images and rejects broken or replaced requests',async()=>{
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;if(path==='/'){return new Response('<img id="initial" src="/ok.png">',{headers:{'Content-Type':'text/html'}});}if(path==='/slow.png')await Bun.sleep(80);return path==='/bad'?new Response('broken',{status:404}):new Response(png,{headers:{'Content-Type':'image/png'}});}});
 const browser=await createBrowser({spareRenderer:false}),cdpServer=CdpServer.create(browser.context).listen(0),c=new CDP(`ws://127.0.0.1:${cdpServer.port}/devtools/browser/cdp-server`);
 try{
  await c.send('Page.navigate',{url:server.url.href});
  expect(await c.evaluate('(async()=>{await initial.decode();const c=document.createElement("canvas").getContext("2d");c.drawImage(initial,0,0);return [initial.complete,initial.naturalWidth,initial.naturalHeight,c.getImageData(0,0,1,1).data[3]]})()')).toEqual([true,1,1,255]);
  expect(await c.evaluate('(async()=>{const im=new Image();const p=im.decode();im.src="/slow.png";await p;return [im.complete,im.naturalWidth]})()')).toEqual([true,1]);
  expect(await c.evaluate('(async()=>{const im=new Image();im.src="/slow.png";await Promise.all([im.decode(),im.decode()]);let sync=true;const p=im.decode().then(()=>sync);sync=false;return await p})()')).toBe(false);
  for(const src of['','/bad','http://['])expect(await c.evaluate(`(async()=>{const im=new Image();im.src=${JSON.stringify(src)};try{await im.decode();return 'resolved'}catch(e){return e.name}})()`)).toBe('EncodingError');
  expect(await c.evaluate('(async()=>{const im=new Image();im.src="/slow.png";const p=im.decode().then(()=>"resolved",e=>e.name);await Promise.resolve();im.removeAttribute("src");return await p})()')).toBe('EncodingError');
 }finally{c.close();cdpServer.stop(true);browser.close();server.stop(true);}
},30000);

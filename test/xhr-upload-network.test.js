import {test,expect} from 'bun:test';
import {NetworkService} from '../lib/network/network-service.js';
const bytes=new TextEncoder().encode('a'.repeat(150000));

test('XHR upload reports actual consumption, forces CORS preflight and preserves redirect bytes', async () => {
 const calls=[],progress=[];
 const network=new NetworkService({fetch:async(url,init)=>{
  calls.push([url,init.method]);
  const headers={'access-control-allow-origin':'https://page.test','access-control-allow-methods':'POST'};
  if(init.method==='OPTIONS')return new Response(null,{headers});
  expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(bytes);
  if(url.endsWith('/start'))return new Response(null,{status:307,headers:{...headers,location:'/end'}});
  return new Response('ok',{headers});
 }});
 const result=await network.pageFetch({url:'https://other.test/start',method:'POST',body:bytes,uploadEvents:true},'https://page.test/',{onUpload:e=>progress.push(e)});
 expect(result.status).toBe(200);expect(calls.map(c=>c[1])).toEqual(['OPTIONS','POST','OPTIONS','POST']);
 expect(progress.at(-1)).toEqual({loaded:bytes.length,done:true});expect(progress.filter(e=>e.done)).toHaveLength(1);
});

test('unused/failed uploads do not report completion and failed preflight never consumes a body', async () => {
 const events=[];
 const network=new NetworkService({fetch:async()=>{throw Error('network unavailable')}});
 await expect(network.pageFetch({url:'https://page.test/',method:'POST',body:bytes,uploadEvents:true},'https://page.test/',{onUpload:e=>events.push(e)})).rejects.toThrow();
 expect(events).toEqual([]);
 let posts=0;
 const denied=new NetworkService({fetch:async(_url,init)=>{if(init.method==='POST')posts++;return new Response('denied',{status:403})}});
 await expect(denied.pageFetch({url:'https://other.test/',method:'POST',body:bytes,uploadEvents:true},'https://page.test/',{onUpload:e=>events.push(e)})).rejects.toThrow();
 expect(posts).toBe(0);expect(events).toEqual([]);
});

test('each resolved-address retry gets an independent upload stream', async () => {
 let count=0;
 const network=new NetworkService({resolver:{addresses:async()=>[{address:'127.0.0.2',family:4},{address:'127.0.0.1',family:4}]},fetch:async(_url,init)=>{
  const result=await new Response(init.body).bytes();expect(result).toEqual(bytes);
  if(++count===1)throw Object.assign(Error('refused'),{code:'ECONNREFUSED'});
  return new Response('ok');
 }});
 expect((await network.pageFetch({url:'http://page.test/',method:'POST',body:bytes,uploadEvents:true},'http://page.test/',{onUpload(){}})).status).toBe(200);
 expect(count).toBe(2);
});

test('Bun HTTP transport consumes an upload before response headers, retaining Content-Length', async () => {
 const progress=[],seen=[];
 const server=Bun.serve({port:0,async fetch(request){seen.push(request.headers.get('content-length'));expect(await request.bytes()).toEqual(bytes);return new Response('ok')}});
 try {
  const network=new NetworkService();
  const result=await network.pageFetch({url:server.url.href,method:'POST',body:bytes,uploadEvents:true},server.url.href,{onUpload:e=>progress.push(e)});
  expect(result.status).toBe(200);expect(seen).toEqual([String(bytes.length)]);expect(progress.at(-1)).toEqual({loaded:bytes.length,done:true});
 }finally{server.stop(true)}
});

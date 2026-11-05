import {test,expect,beforeAll,afterAll} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';
let renderer;
const requests=[];
beforeAll(async()=>{
 renderer=new RendererHost({timeout:20000,network:new NetworkService({fetch:async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/fail')throw Error('offline');
  if(path==='/slow')await Bun.sleep(90);
  const body=init.body?await new Response(init.body).text():'';
  requests.push({path,body});
  return new Response(path==='/'?'<!doctype html><p>upload</p>':body||'ok',{headers:{'content-type':path==='/'?'text/html':'text/plain'}});
 }})});
 await renderer.start();await renderer.call('loadDocument',{url:'https://upload.test/',source:'<!doctype html><p>upload</p>',contentType:'text/html'});
});
afterAll(()=>renderer?.close());
const evaluate=s=>renderer.call('evaluate',s);

test('upload is an EventTarget and dispatches trusted ProgressEvents before response events',async()=>{
 const result=await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];
 const record=e=>events.push([e.target===x.upload?'upload':'xhr',e.type,e.loaded,e.total,e.lengthComputable,e instanceof ProgressEvent,e.isTrusted,e.currentTarget===e.target]);
 for(const type of ['loadstart','progress','load','loadend'])x.upload.addEventListener(type,record);
 x.onloadstart=record;x.onloadend=()=>resolve({events,body:x.responseText,types:[x instanceof XMLHttpRequest,x instanceof XMLHttpRequestEventTarget,x instanceof EventTarget,x.upload instanceof XMLHttpRequestUpload,x.upload instanceof EventTarget]});
 x.open('POST','/echo');x.send('牛');})`);
 expect(result.types).toEqual([true,true,true,true,true]);expect(result.body).toBe('牛');
 expect(result.events).toEqual([['xhr','loadstart',0,0,false,true,true,true],['upload','loadstart',0,3,true,true,true,true],['upload','progress',3,3,true,true,true,true],['upload','load',3,3,true,true,true,true],['upload','loadend',3,3,true,true,true,true]]);
});

test('aborting upload loadstart may open and send a replacement without stale request state or timers',async()=>{
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];let finished=0;
 x.upload.onloadstart=()=>{events.push('start:'+x.readyState);x.abort();events.push('after:'+x.readyState)};
 x.upload.onabort=()=>{events.push('upload-abort:'+x.readyState);x.open('GET','/replacement');x.timeout=0;x.send()};
 x.onabort=()=>events.push('abort:'+x.readyState);x.onload=()=>events.push('load:'+x.readyState);
 x.onloadend=()=>{events.push('end:'+x.readyState);if(++finished===2)setTimeout(()=>resolve([events,x.responseText]),80)};
 x.open('POST','/slow');x.timeout=20;x.send('old')})`)).toEqual([['start:1','upload-abort:4','abort:1','end:1','after:1','load:4','end:4'],'ok']);
 expect(requests.some(r=>r.path==='/slow')).toBeFalse();
});

test('upload errors finish before download errors, and completed upload does not abort again',async()=>{
 for(const [path,timeout,type] of [['/fail',0,'error'],['/slow',5,'timeout']]){
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('POST',${JSON.stringify(path)});x.timeout=${timeout};
  for(const target of [x.upload,x])for(const type of ['error','timeout','abort','loadend'])target.addEventListener(type,e=>{events.push([target===x.upload?'upload':'xhr',e.type,e.loaded,e.total]);if(target===x&&type==='loadend')resolve(events)});x.send('body')})`)).toEqual([['upload',type,0,0],['upload','loadend',0,0],['xhr',type,0,0],['xhr','loadend',0,0]]);
 }
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('POST','/echo');
 x.upload.onload=()=>events.push('upload-load');x.upload.onabort=()=>events.push('upload-abort');
 x.onreadystatechange=()=>{if(x.readyState===2)x.abort()};x.onabort=()=>events.push('abort');x.onloadend=()=>resolve(events);x.send('body')})`)).toEqual(['upload-load','abort']);
});

test('upload listeners are sampled at send, and GET/HEAD/null bodies have no upload events',async()=>{
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('POST','/echo');x.onloadend=()=>resolve(events);x.send('body');for(const t of ['loadstart','progress','load','loadend'])x.upload['on'+t]=()=>events.push(t)})`)).toEqual([]);
 for(const [method,body] of [['GET',"'ignored'"],['HEAD',"'ignored'"],['POST','null']]){
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('${method}','/echo');for(const t of ['loadstart','progress','load','loadend'])x.upload['on'+t]=()=>events.push(t);x.onloadend=()=>resolve(events);x.send(${body})})`)).toEqual([]);
 }
});

test('upload event handlers and once listeners share the normal EventTarget path',async()=>{
 expect(await evaluate(`(()=>{const x=new XMLHttpRequest(),u=x.upload,out=[];const removed=()=>out.push('removed');
 u.addEventListener('custom',removed);u.removeEventListener('custom',removed);
 u.addEventListener('custom',{handleEvent(e){out.push([e.type,e.target===u,e.currentTarget===u])}},{once:true});
 u.dispatchEvent(new Event('custom'));u.dispatchEvent(new Event('custom'));let impossible;
 try{new XMLHttpRequestUpload()}catch(e){impossible=e instanceof TypeError}
 return [out,impossible]})()`)).toEqual([[['custom',true,true]],true]);
});

test('body conversion reentry cannot overwrite an inner send or use an obsolete request method',async()=>{
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();let error;x.open('POST','/inner');
 x.onloadend=()=>resolve([error,x.responseText]);try{x.send({toString(){x.send('inner');return 'outer'}})}catch(e){error=e.name}})`)).toEqual(['InvalidStateError','inner']);
 expect(requests.filter(r=>r.path==='/inner').map(r=>r.body)).toEqual(['inner']);
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('POST','/obsolete');
 x.upload.onloadstart=()=>events.push('upload');x.onloadend=()=>resolve([events,x.responseText]);
 x.send({toString(){x.open('GET','/reopened-get');return 'discarded'}})})`)).toEqual([[],'ok']);
 expect(requests.find(r=>r.path==='/reopened-get').body).toBe('');
 expect(requests.some(r=>r.path==='/obsolete')).toBeFalse();
 expect(await evaluate(`(()=>{const x=new XMLHttpRequest();let called=false,error;try{x.send({toString(){called=true;return 'x'}})}catch(e){error=e.name}return [called,error]})()`)).toEqual([true,'InvalidStateError']);
});

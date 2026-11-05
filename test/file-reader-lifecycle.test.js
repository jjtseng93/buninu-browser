import {test,expect} from 'bun:test';
import {fileReaderInterface} from '../lib/renderer/file-input.js';
import {progressEventInterface} from '../lib/renderer/progress-event.js';
import {RendererHost} from '../lib/renderer/host.js';

const ProgressEvent=progressEventInterface(Event);
const FileReader=fileReaderInterface({EventTarget,runTask:fn=>fn(),
 createProgressEvent:(type,init)=>new ProgressEvent(type,init)});
const end=reader=>new Promise(resolve=>reader.addEventListener('loadend',resolve,{once:true}));
const textBytes=value=>new TextEncoder().encode(value).buffer;
class DeferredBlob extends Blob {
 pending=Promise.withResolvers();
 started=Promise.withResolvers();
 arrayBuffer(){this.started.resolve();return this.pending.promise;}
}

for(const method of ['readAsText','readAsArrayBuffer','readAsBinaryString','readAsDataURL']){
 test(`FileReader ${method} reports pending state and byte progress before exposing its result`,async()=>{
  const reader=new FileReader(),events=[];
  for(const type of ['loadstart','progress','load','loadend'])reader.addEventListener(type,event=>events.push({
   type,state:reader.readyState,result:reader.result,loaded:event.loaded,total:event.total,
   computable:event.lengthComputable,progress:event instanceof ProgressEvent,
   target:event.target===reader,bubbles:event.bubbles,cancelable:event.cancelable,
  }));
  const complete=end(reader);reader[method](new Blob(['é']));
  expect(reader.readyState).toBe(FileReader.LOADING);expect(reader.result).toBeNull();expect(events).toEqual([]);
  await complete;
  expect(events.map(event=>event.type)).toEqual(['loadstart','progress','load','loadend']);
  expect(events.map(event=>event.state)).toEqual([1,1,2,2]);
  expect(events.slice(0,2).map(event=>event.result)).toEqual([null,null]);
  expect(events.slice(2).every(event=>event.result!==null)).toBe(true);
  expect(events.map(event=>event.loaded)).toEqual([0,2,2,2]);
  expect(events.every(event=>event.total===2&&event.computable&&event.progress&&event.target&&!event.bubbles&&!event.cancelable)).toBe(true);
 });
}

test('an empty Blob omits progress while completing asynchronously',async()=>{
 const reader=new FileReader(),events=[];
 for(const type of ['loadstart','progress','load','loadend'])reader.addEventListener(type,event=>events.push([type,event.loaded,event.total]));
 const complete=end(reader);reader.readAsText(new Blob());await complete;
 expect(events).toEqual([['loadstart',0,0],['load',0,0],['loadend',0,0]]);
 expect(reader.result).toBe('');
});

test('abort in loadstart cancels the old IO and can start a replacement read',async()=>{
 const reader=new FileReader(),first=new DeferredBlob(['first']),events=[];
 let oldReadStarted=false;first.started.promise.then(()=>{oldReadStarted=true;});
 for(const type of ['loadstart','abort','progress','load','loadend'])reader.addEventListener(type,()=>events.push(type));
 reader.addEventListener('loadstart',()=>reader.abort(),{once:true});
 reader.addEventListener('abort',()=>reader.readAsText(new Blob(['second'])),{once:true});
 const complete=end(reader);reader.readAsText(first);await complete;
 expect(reader.result).toBe('second');expect(oldReadStarted).toBe(false);
 expect(events).toEqual(['loadstart','abort','loadstart','progress','load','loadend']);
});

test('abort from progress cannot publish the old result or complete a replacement',async()=>{
 const reader=new FileReader(),events=[];
 for(const type of ['loadstart','abort','progress','load','loadend'])reader.addEventListener(type,()=>events.push(type));
 reader.addEventListener('progress',()=>reader.abort(),{once:true});
 reader.addEventListener('abort',()=>reader.readAsText(new Blob(['second'])),{once:true});
 const complete=end(reader);reader.readAsText(new Blob(['first']));await complete;
 expect(reader.result).toBe('second');expect(reader.error).toBeNull();
 expect(events).toEqual(['loadstart','progress','abort','loadstart','progress','load','loadend']);
});

for(const outcome of ['resolve','reject']){
 test(`a stale ${outcome} after abort cannot change the replacement read`,async()=>{
  const reader=new FileReader(),first=new DeferredBlob(['first']),second=new DeferredBlob(['second']),events=[];
  for(const type of ['abort','load','error','loadend'])reader.addEventListener(type,()=>events.push(type));
  reader.readAsText(first);await first.started.promise;reader.abort();
  reader.readAsText(second);await second.started.promise;
  first.pending[outcome](outcome==='resolve'?textBytes('stale'):new Error('stale failure'));
  await Bun.sleep(5);
  expect(reader.readyState).toBe(1);expect(reader.result).toBeNull();expect(reader.error).toBeNull();
  expect(events).toEqual(['abort','loadend']);
  const complete=end(reader);second.pending.resolve(textBytes('second'));await complete;
  expect(reader.result).toBe('second');expect(events).toEqual(['abort','loadend','load','loadend']);
 });
}

for(const type of ['load','error']){
 test(`a new read in ${type} suppresses the old loadend`,async()=>{
  const reader=new FileReader(),events=[];
  for(const name of ['load','error','loadend'])reader.addEventListener(name,()=>events.push(name));
  reader.addEventListener(type,()=>reader.readAsText(new Blob(['second'])),{once:true});
  const complete=end(reader),first=new DeferredBlob(['first']);reader.readAsText(first);await first.started.promise;
  if(type==='error')first.pending.reject(new Error('read failure'));else first.pending.resolve(textBytes('first'));
  await complete;
  expect(reader.result).toBe('second');expect(reader.error).toBeNull();
  expect(events).toEqual([type,'load','loadend']);
 });
}

test('abort without a pending read only clears the result and preserves state',async()=>{
 const reader=new FileReader(),events=[];reader.addEventListener('abort',()=>events.push('abort'));
 reader.abort();expect(reader.readyState).toBe(FileReader.EMPTY);expect(reader.result).toBeNull();
 const complete=end(reader);reader.readAsText(new Blob(['first']));await complete;
 reader.abort();expect(reader.readyState).toBe(FileReader.DONE);expect(reader.result).toBeNull();expect(events).toEqual([]);
});

test('FileReader exposes branded byte-progress events through the page bindings',async()=>{
 const renderer=new RendererHost({timeout:20000});
 try{
  await renderer.start();await renderer.call('resize',200,100,1);
  await renderer.call('loadDocument',{url:'https://page.test/',source:'<!doctype html><p>FileReader</p>',contentType:'text/html',status:200});
  await renderer.call('whenLoaded');
  expect(await renderer.call('evaluate',`(async()=>{
   const reader=new FileReader(),events=[];
   for(const type of ['loadstart','progress','load','loadend'])reader.addEventListener(type,e=>events.push([
    type,e instanceof ProgressEvent,e instanceof Event,e.target===reader,e.loaded,e.total,
    e.lengthComputable,reader.readyState,reader.result===null
   ]));
   const done=new Promise(resolve=>reader.addEventListener('loadend',resolve,{once:true}));
   reader.readAsText(new Blob(['é']));await done;return events;
  })()`)).toEqual([
   ['loadstart',true,true,true,0,2,true,1,true],
   ['progress',true,true,true,2,2,true,1,true],
   ['load',true,true,true,2,2,true,2,false],
   ['loadend',true,true,true,2,2,true,2,false],
  ]);
 }finally{renderer.close();}
},30000);

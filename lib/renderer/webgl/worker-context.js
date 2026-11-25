// Keep the page thread available for input while software WebGL renders. A
// worker owns the GL state. Pixel reads and observable queries are barriers.
import {waitWithWebAudio} from '../web-audio-demand.js';
import {receiveMessageOnPort} from 'node:worker_threads';
import {createSoftwareGL} from './context.js';
const blobURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);
const EngineBlob=Blob, EngineWorker=Worker;
let worker, workerURL, queueBytes, next=0;
const contexts=new Map();
let provide, submission=0;
export const glSubmission=()=>submission;
export function waitForGLWrites(document,before){
  if(submission===before)return;
  const waits=[];
  for(const ctx of contexts.values()){
    const done=ctx.waitForWrites(document,before);
    if(done)waits.push(done);
  }
  if(waits.length)return Promise.all(waits);
}
export function setWebGLWorkerAssets(load){provide=load;}
function releaseWorker(thread){
  if(worker!==thread)return;
  worker=null;
  if(workerURL){revokeURL(workerURL);workerURL=null;}
  thread.terminate();
}
function loseWorker(thread){
  if(worker!==thread)return;
  releaseWorker(thread);
  for(const context of contexts.values())context.lost();
}
function acquireWorker(){
  if(worker||!provide)return worker;
  let thread,url;
  try{
    const assets=provide();
    if(!assets)return null;
    url=blobURL(new EngineBlob([assets.source],{type:'application/javascript'}));
    thread=new EngineWorker(url);
    worker=thread;workerURL=url;
    thread.onerror=()=>loseWorker(thread);
    thread.addEventListener('close',()=>loseWorker(thread),{once:true});
    thread.onmessage=({data})=>{
      if(worker!==thread)return;
      if(data==='ready'){if(workerURL)revokeURL(workerURL);workerURL=null;}
      else if(data.fatal)loseWorker(thread);
      else if(data.lost)contexts.get(data.id)?.lost();
      else contexts.get(data.id)?.receive(data);
    };
    queueBytes=new Int32Array(new SharedArrayBuffer(4));
    thread.postMessage({op:'init',wasm:assets.wasm,queueBytes},[assets.wasm.buffer]);
    return thread;
  }catch{
    if(thread)releaseWorker(thread);
    else if(url)revokeURL(url);
    return null;
  }
}
// Preserve typed-array and DataView brands across realms. Never construct a
// view through a caller-controlled constructor or transfer its original buffer.
const typedArrayBrand=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),Symbol.toStringTag).get;
const viewTypes=new Map([Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,
  Float32Array,Float64Array,BigInt64Array,BigUint64Array,...(typeof Float16Array==='undefined'?[]:[Float16Array])].map(type=>[type.name,type]));
function copyView(view,shared=false){
  const buffer=shared?new SharedArrayBuffer(view.byteLength):new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(view.buffer,view.byteOffset,view.byteLength));
  const Type=viewTypes.get(typedArrayBrand.call(view))??DataView;
  return new Type(buffer);
}
const reflected=new Set(['getUniformLocation','getProgramParameter','getProgramInfoLog','getAttribLocation','getActiveAttrib','getActiveUniform']);
const draws = new Set(['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']);
const loads=new WeakMap();
export function waitForWebGLPresentation(document,ready){
  const load=loads.get(document);
  if(!load?.active.size)return false;
  // Wait for each canvas already in flight once. New submissions are part
  // of the next opportunity and cannot continually postpone this callback.
  load.fences.set(ready,new Set(load.active));
  return true;
}
const micro=queueMicrotask;
export function createWorkerGL(kit,state,changed,options,webgl2){
  const thread=acquireWorker();
  if(!thread)return createSoftwareGL(kit,state,changed,options,webgl2);
  const id=++next;
  const {port1:responses,port2}=new MessageChannel();
  const objects=new Map();
  const signal=new Int32Array(new SharedArrayBuffer(12));
  let description;
  try{
    thread.postMessage({id,op:'open',port:port2,signal,width:state.width,height:state.height,depth:!!(options?.depth??true)},[port2]);
    if(waitWithWebAudio(signal,0,30000)!=='timed-out'&&!signal[2])
      description=receiveMessageOnPort(responses)?.message;
  }catch{/* A failed worker startup can still use the in-process renderer. */}
  if(!description){
    responses.close();
    if(contexts.size)thread.postMessage({id,op:'close'});
    else releaseWorker(thread);
    return createSoftwareGL(kit,state,changed,options,webgl2);
  }
  const {constants,methods}=description;
  const proxy=Object.create(null),map=new WeakMap();
  for(const [name,value] of Object.entries(constants))Object.defineProperty(proxy,name,{value,enumerable:true});
  let publicCanvas=options?.canvas?new WeakRef(options.canvas):null;
  let drawFramebuffer=null;
  const framebuffers=new WeakSet();
  const doc=state.node.deref()?.ownerDocument;
  const owner=doc?new WeakRef(doc):null;
  const load=loads.get(doc)??{active:new Set(),fences:new Map()};
  if(doc)loads.set(doc,load);
  let lost=false,reportedLoss=false;
  let resolveImage=options?.resolveImage;
  let outstanding=false,epoch=0,lastDisplayed=-1,writeVersion=0,readVersion=0;
  let lastWrite=0;
  const waiters=new Map();
  function releaseWaiters(){
    for(const [done,version] of waiters)if(lost||closed||readVersion>=version){
      waiters.delete(done);done();
    }
  }
  function waitForWrites(document,before){
    if(document!==owner?.deref()||lastWrite<=before||readVersion>=writeVersion||lost||closed)return;
    // Later animation submissions must not extend this wait.
    const version=writeVersion;
    return new Promise(done=>waiters.set(done,version));
  }
  function retire(){
    if(!outstanding)return;
    outstanding=false;load.active.delete(id);
    for(const [ready,contexts] of load.fences){
      contexts.delete(id);
      if(!contexts.size){load.fences.delete(ready);ready();}
    }
  }
  const expiredHandles=new Set();
  // Release an ID after all earlier commands using it. If the GL still owns
  // the underlying object (for example a bound buffer), a later query can
  // recreate its wrapper with the original ID.
  const collectedHandles=new FinalizationRegistry(key=>{
    if(closed||lost)return;
    expiredHandles.add(key);
    if(expiredHandles.size===1)micro(()=>{if(!closed&&!lost&&expiredHandles.size)send('run');});
  });

  let pending=[],serial=0,nextObject=0,queued=false,closed=false,dirty=false,queuedBytes=0;
  let transfers=[];
  const send=(op,more={})=>{
    // Include a cost for commands without uploads. A single large upload is
    // allowed only when earlier batches have been consumed by the renderer.
    const released=[];
    for(const key of expiredHandles)if(!objects.get(key)?.deref()){objects.delete(key);released.push(key);}
    expiredHandles.clear();
    const cost=64+released.length*8+queuedBytes+pending.length*128;
    let used;
    while((used=Atomics.load(queueBytes,0))>0&&used+cost>64*1024*1024){
      if(waitWithWebAudio(queueBytes,used,120000)==='timed-out'){lose();throw Error('WebGL queue stalled');}
    }
    Atomics.add(queueBytes,0,cost);
    try{thread.postMessage({op,id,serial,epoch,version:writeVersion,commands:pending,released,cost,...more},transfers);}
    catch(error){Atomics.sub(queueBytes,0,cost);lose();throw error;}
    pending=[];queuedBytes=0;transfers=[];
  };
  function barrier(op,more={}){
    const signal=new Int32Array(new SharedArrayBuffer(12));
    send(op,{...more,signal});
    if(waitWithWebAudio(signal,0,120000)==='timed-out'||signal[2]){
      lose();
      throw Error('WebGL worker did not finish the request');
    }
  }
  function lose(){
    if(lost||closed)return;
    lost=true;dirty=false;pending=[];transfers=[];queuedBytes=0;
    contexts.delete(id);retire();releaseWaiters();
    responses.close();objects.clear();
    if(worker===thread){
      if(contexts.size)thread.postMessage({id,op:'close'});
      else releaseWorker(thread);
    }
  }
  function receive(frame){
    // Only one bitmap is in flight per context. Commands remain ordered.
    retire();
    if(dirty&&!closed)present();
    if(closed||epoch!==frame.epoch||frame.serial<=lastDisplayed||state.width!==frame.width||state.height!==frame.height)return;
    state.raster.getCanvas().writePixels(frame.pixels,state.width,state.height,0,0,kit.AlphaType.Premul,kit.ColorType.RGBA_8888,kit.ColorSpace.SRGB);
    lastDisplayed=frame.serial;readVersion=frame.version;changed(state,true);releaseWaiters();
  }
  contexts.set(id,{receive,lost:lose,waitForWrites});
  function present(){
    if(queued||outstanding||lost||closed)return;
    queued=true;
    micro(()=>{
      queued=false;
      if(lost||closed||!dirty)return;
      dirty=false;
      serial++;
      outstanding=true;
      load.active.add(id);
      send('present');
    });
  }
  const programs=new WeakMap();
  function query(op,more={}){
    barrier(op,{...more,reply:true});
    return receiveMessageOnPort(responses).message;
  }
  function reflect(program){
    let info=programs.get(program);
    if(!info){
      info=query('reflect',{program:map.get(program)}).value;
      info.names=new Set(info.uniforms.map(u=>u.name.replace(/\[0\]$/,'')));
      info.locations=new Map(info.attributes.map(([a,l])=>[a.name,l]));
      programs.set(program,info);
    }
    return info;
  }
  const wrap=(key,type)=>{
    let obj=objects.get(key)?.deref();
    if(obj)return obj;
    obj=Object.create(null);
    if(type)Object.defineProperty(obj,Symbol.toStringTag,{value:type});
    map.set(obj,key);objects.set(key,new WeakRef(obj));collectedHandles.register(obj,key);
    if(type==='WebGLFramebuffer')framebuffers.add(obj);
    return obj;
  };
  for(const name of methods){
    const call=(...values)=>{
      if(lost||closed){
        if(name==='isContextLost')return true;
        if(name==='getError'){const error=reportedLoss?0:0x9242;reportedLoss=true;return error;}
        if(/^(create|get)/.test(name))return null;
        return;
      }
      if(name==='isContextLost')return false;
      let uniformKnown=false;
      if(reflected.has(name)&&map.has(values[0])){
        const info=reflect(values[0]),k=values[1];
        if(name==='getUniformLocation'){
          if(!info.names.has(String(k).replace(/\[0\]$/,'')))return null;
          uniformKnown=true;
        }else if(name==='getProgramInfoLog')return info.log;
        else if(name==='getAttribLocation')return info.locations.get(k)??-1;
        else if(name==='getActiveAttrib')return info.attributes[k]?{...info.attributes[k][0]}:null;
        else if(name==='getActiveUniform')return info.uniforms[k]?{...info.uniforms[k]}:null;
        else if(k===constants.ACTIVE_UNIFORMS)return info.uniforms.length;
        else if(k===constants.ACTIVE_ATTRIBUTES)return info.attributes.length;
        else if(k===constants.LINK_STATUS||k===constants.VALIDATE_STATUS)return info.linked;
      }
      if(name==='linkProgram'||name==='deleteProgram')programs.delete(values[0]);
      const creates=name.startsWith('create');
      const remoteQuery=!uniformKnown&&/^(get|is|check)/.test(name);
      let args=values, refs=[], bind=0, result;
      if(creates){
        bind=++nextObject;result=wrap(bind,'WebGL'+name.slice(6)+(name==='createVertexArray'?'Object':''));
      }else if(name==='getUniformLocation'){
        bind=++nextObject;
        if(uniformKnown)result=wrap(bind,'WebGLUniformLocation');
      }
      if(name==='bindFramebuffer'&&(values[0]===constants.FRAMEBUFFER||values[0]===constants.DRAW_FRAMEBUFFER)&&
          (values[1]===null||framebuffers.has(values[1])))drawFramebuffer=values[1];
      if(name==='deleteFramebuffer'&&values[0]){
        framebuffers.delete(values[0]);if(drawFramebuffer===values[0])drawFramebuffer=null;
      }
      let domUpload,commandBytes=0;
      const commandTransfers=[];
      if((name==='texImage2D'&&args.length===6)||(name==='texSubImage2D'&&args.length===7)){
        const src=resolveImage?.(args.at(-1));
        if(src?.originClean===false)throw new DOMException('Cross-origin texture','SecurityError');
        const pixels=src?.image?.readPixels(0,0,{width:src.width,height:src.height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
        domUpload=pixels?{width:src.width,height:src.height,pixels:Uint8Array.from(pixels)}:null;
        if(domUpload){commandTransfers.push(domUpload.pixels.buffer);commandBytes+=domUpload.pixels.byteLength;}
        args=[...values.slice(0,-1),domUpload];
      }
      // Preserve the caller's view, including untouched output elements.
      // The worker writes the exact typed buffer and acknowledges on return.
      let readback;
      if(name==='readPixels'&&ArrayBuffer.isView(args[6])&&typedArrayBrand.call(args[6]))
        readback=copyView(args[6],true);
      const cloned=args.map((a,i)=>{
        if(readback&&i===6)return readback;
        if(a&&map.has(a)){refs.push(i,map.get(a));return null;}
        if(ArrayBuffer.isView(a)){
          const copy=copyView(a);
          commandTransfers.push(copy.buffer);commandBytes+=copy.byteLength;
          return copy;
        }
        if(Array.isArray(a)){commandBytes+=a.length*8;return Array.from(a,Number);}
        if(typeof a==='string')commandBytes+=a.length*2;
        if(a instanceof ArrayBuffer || a instanceof SharedArrayBuffer){
          const copy=new Uint8Array(a).slice().buffer;
          commandBytes+=copy.byteLength;commandTransfers.push(copy);return copy;
        }
        if(typeof a==='symbol')throw new TypeError('Invalid WebGL argument');
        if(a===domUpload)return a;
        // Foreign resource wrappers cannot be rebound in this context.
        if(a!==null&&(typeof a==='object'||typeof a==='function'))return {};
        return a;
      });
      transfers.push(...commandTransfers);queuedBytes+=commandBytes;
      pending.push([name,bind,refs,cloned]);
      if(name==='readPixels'){
        barrier('sync');
        if(readback)new Uint8Array(values[6].buffer,values[6].byteOffset,values[6].byteLength).set(new Uint8Array(readback.buffer));
        return;
      }
      if(remoteQuery){
        const {handle,type,value}=query('sync');
        return handle?wrap(handle,type):value;
      }
      if(name==='finish'){if(readVersion!==writeVersion)syncBitmap();else barrier('sync');return;}
      if(name==='flush'){send('run');return;}
      const drawsColor=draws.has(name)||(name==='clear'&&(values[0]&constants.COLOR_BUFFER_BIT))||
        (name==='blitFramebuffer'&&(values[8]&constants.COLOR_BUFFER_BIT));
      if(drawsColor&&!drawFramebuffer){
        dirty=true;writeVersion++;lastWrite=++submission;present();
      }
      if(pending.length>=256||queuedBytes>=1048576)send('run');
      return result;
    };
    Object.defineProperty(proxy,name,{value:call,enumerable:true});
  }
  Object.defineProperties(proxy,{canvas:{get:()=>publicCanvas?.deref()??null},drawingBufferWidth:{get:()=>state.width},drawingBufferHeight:{get:()=>state.height},[Symbol.toStringTag]:{value:'WebGL2RenderingContext'}});
  function syncBitmap(){
    if(lost||closed||readVersion===writeVersion)return;
    const pixels=new Uint8Array(new SharedArrayBuffer(state.width*state.height*4));
    const previous=serial;
    barrier('snapshot',{bytes:pixels});
    state.raster.getCanvas().writePixels(pixels,state.width,state.height,0,0,kit.AlphaType.Premul,kit.ColorType.RGBA_8888,kit.ColorSpace.SRGB);
    dirty=false;readVersion=writeVersion;lastDisplayed=previous;changed(state);releaseWaiters();
  }
  return {proxy,asyncPresentation:true,flush:syncBitmap,discardDrawingBuffer(){
    if(lost||closed)return;
    send('run');epoch++;dirty=false;readVersion=++writeVersion;releaseWaiters();
    thread.postMessage({op:'discard',id});
  },configure(o){
    resolveImage=o.resolveImage;
    publicCanvas=o.canvas?new WeakRef(o.canvas):null;
  },reset(){
    if(lost||closed)return;
    epoch++;dirty=false;readVersion=writeVersion;releaseWaiters();
    send('run');thread.postMessage({op:'resize',id,width:state.width,height:state.height});
  },dispose(){
    if(closed)return;
    closed=true;dirty=false;releaseWaiters();retire();contexts.delete(id);
    if(!lost&&worker===thread){
      if(contexts.size)thread.postMessage({op:'close',id});
      else releaseWorker(thread);
    }
    responses.close();objects.clear();pending=[];transfers=[];
  }};
}

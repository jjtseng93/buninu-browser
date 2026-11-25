// This worker executes the same software context as the in-process path. Each
// batch is ordered with respect to uploads, queries and presentation fences.
import CanvasKitInit from '../../../usr/lib/canvaskit/canvaskit.js';
import {createSoftwareGL} from './context.js';
import {makeRasterSurface,copyRasterSurfacePixels} from '../raster-surface.js';

const contexts=new Map();
let kit,ready,queueBytes;

function raster(width,height){
  const surface=makeRasterSurface(kit,width,height);
  if(!surface)throw Error('Cannot allocate WebGL drawing buffer');
  return surface;
}

function open(message){
  const {width,height,port,id}=message;
  const surface=raster(width,height);
  const state={width,height,raster:surface,surface};
  try{
    // The renderer resolved the DOM source and checked its origin before
    // sending tightly packed, unpremultiplied RGBA. Keep the DOM overload
    // so typed-array unpack offsets do not apply to these rows.
    const resolveImage=source=>source?.pixels && {
      width:source.width,height:source.height,image:{readPixels:()=>source.pixels}
    };
    const gl=createSoftwareGL(kit,state,()=>{},{depth:message.depth,resolveImage},true);
    contexts.set(id,{state,gl,port,handles:new Map(),ids:new WeakMap()});
    const methods=[],constants={};
    for(const [name,value] of Object.entries(gl.proxy)){
      if(typeof value==='function')methods.push(name);
      else constants[name]=value;
    }
    port.postMessage({methods,constants});
  }catch(error){surface.dispose();throw error;}
}

function close(id){
  const item=contexts.get(id);
  if(!item)return;
  contexts.delete(id);
  item.port.close();
  item.gl.dispose();
  item.state.raster.dispose();
}

function programInfo(gl,program){
  const uniforms=Array.from({length:gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS)},
    (_,i)=>gl.getActiveUniform(program,i));
  const attributes=Array.from({length:gl.getProgramParameter(program,gl.ACTIVE_ATTRIBUTES)},(_,i)=>{
    const info=gl.getActiveAttrib(program,i);
    return [info,gl.getAttribLocation(program,info.name)];
  });
  return {uniforms,attributes,linked:gl.getProgramParameter(program,gl.LINK_STATUS),log:gl.getProgramInfoLog(program)};
}

function execute(item,message){
  const {gl,state,handles,ids,port}=item;
  let value;
  for(const [method,bind,refs,args] of message.commands){
    for(let i=0;i<refs.length;i+=2)args[refs[i]]=handles.get(refs[i+1]);
    value=gl.proxy[method](...args);
    if(bind&&value){handles.set(bind,value);ids.set(value,bind);}
  }
  for(const key of message.released)handles.delete(key);
  if(message.op==='reflect')value=programInfo(gl.proxy,handles.get(message.program));
  if(message.op==='present'||message.op==='snapshot'){
    gl.flush();
    const {width,height}=state;
    const pixels=message.bytes??new Uint8Array(width*height*4);
    if(!copyRasterSurfacePixels(state.raster,pixels,{width,height,premultiplied:true}))throw Error('WebGL presentation failed');
    if(message.op==='present'){
      const {id,serial,epoch,version}=message;
      postMessage({id,serial,epoch,version,width,height,pixels},[pixels.buffer]);
    }
  }
  if(message.reply){
    const handle=ids.get(value);
    if(handle)handles.set(handle,value);
    port.postMessage(handle?{handle,type:value[Symbol.toStringTag]}:{value});
  }
}

onmessage=async({data:message})=>{
  if(message.op==='init'){
    queueBytes=message.queueBytes;
    ready=CanvasKitInit({wasmBinary:message.wasm}).then(result=>{kit=result;postMessage('ready');},()=>{postMessage({fatal:true});});
    return;
  }
  try{
    await ready;
    if(!kit)throw Error('CanvasKit initialization failed');
    const item=contexts.get(message.id);
    switch(message.op){
      case 'open':open(message);break;
      case 'close':close(message.id);break;
      case 'resize':{
        const {width,height}=message,state=item.state,next=raster(width,height);
        state.raster.dispose();
        state.width=width;state.height=height;state.surface=state.raster=next;
        item.gl.reset();
        break;
      }
      case 'discard':item.gl.flush();item.gl.discardDrawingBuffer();break;
      default:execute(item,message);
    }
  }catch{
    close(message.id);
    if(message.signal)message.signal[2]=1;
    postMessage({id:message.id,lost:true});
  }finally{
    if(message.cost){Atomics.sub(queueBytes,0,message.cost);Atomics.notify(queueBytes,0);}
    if(message.signal){Atomics.store(message.signal,0,1);Atomics.notify(message.signal,0);}
  }
};

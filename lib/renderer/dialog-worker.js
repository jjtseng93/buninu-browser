// This worker stays responsive while the page thread waits synchronously for
// alert/confirm/prompt. The authenticated socket is opened before seccomp.
import {connectCompositor} from './compositor-channel.js';
let pending=null,channel,fileId=null;
function finishSync(buffer,result={}) {
  const state=new Int32Array(buffer,0,3);
  let value=String(result.promptText??'');
  try { buffer.grow(12+value.length*2); }
  catch { value='';result={accept:false}; }
  const text=new Uint16Array(buffer,12);
  for(let i=0;i<value.length;i++)text[i]=value.charCodeAt(i);
  state[1]=value.length;state[2]=result.accept?1:0;
  Atomics.store(state,0,1);Atomics.notify(state,0);
}
function finish(result={}) {
  if(fileId!==null){postMessage({type:'files',id:fileId,result});fileId=null;return;}
  if(!pending)return;
  const buffer=pending;pending=null;
  finishSync(buffer,result);
}
self.onmessage=async({data})=>{
  if(data.type==='connect') {
    try{channel=await connectCompositor(data.endpoint,message=>finish(message),()=>{channel=null;finish();});postMessage({type:'ready'});}
    catch(error){postMessage({type:'error',message:String(error)});}
  } else if(data.type==='files') {
    if(pending||fileId!==null){postMessage({type:'files',id:data.id,result:{accept:false}});return;}
    fileId=data.id;try{if(!channel)throw Error('Dialog channel closed');channel.send(data.request);}catch{finish();}
  } else if(data.type==='dialog') {
    // A page timer may request a synchronous dialog while a file picker is
    // open. Never replace either outstanding reply or leave its page blocked.
    if(pending||fileId!==null){finishSync(data.buffer,{accept:false});return;}
    pending=data.buffer;
    try{if(!channel)throw Error('Dialog channel closed');channel.send(data.request);}catch{finish();}
  }
};

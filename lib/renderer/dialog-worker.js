// This worker stays responsive while the page thread waits synchronously for
// alert/confirm/prompt. The authenticated socket is opened before seccomp.
import {connectCompositor} from './compositor-channel.js';
let pending=null,channel;
function finish(result={}) {
  if(!pending)return;
  const buffer=pending;pending=null;
  const state=new Int32Array(buffer,0,3);
  let value=String(result.promptText??'');
  try { buffer.grow(12+value.length*2); }
  catch { value='';result={accept:false}; }
  const text=new Uint16Array(buffer,12);
  for(let i=0;i<value.length;i++)text[i]=value.charCodeAt(i);
  state[1]=value.length;state[2]=result.accept?1:0;
  Atomics.store(state,0,1);Atomics.notify(state,0);
}
self.onmessage=async({data})=>{
  if(data.type==='connect') {
    try{channel=await connectCompositor(data.endpoint,message=>finish(message),()=>{channel=null;finish();});postMessage({type:'ready'});}
    catch(error){postMessage({type:'error',message:String(error)});}
  } else if(data.type==='dialog') {
    pending=data.buffer;
    try{if(!channel)throw Error('Dialog channel closed');channel.send(data.request);}catch{finish();}
  }
};

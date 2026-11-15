import {parentPort} from 'node:worker_threads';
import {createWebView} from './webview-engine.js';
let serial=0,closed=false;
const pending=new Map();
function clipboard(operation,text){
 return new Promise((resolve,reject)=>{
  const id=++serial;pending.set(id,{resolve,reject});parentPort.postMessage({type:'clipboard',operation,text,id});
 });
}
const view=createWebView({
 onFrame:frame=>{if(!closed)parentPort.postMessage({type:'frame',frame},[frame.pixels.buffer]);},
 onState:state=>{if(!closed)parentPort.postMessage({type:'state',state});},
 clipboard:{read:()=>clipboard('read'),write:text=>clipboard('write',text)},
});
parentPort.on('message',async message=>{
 if(message.reply){const item=pending.get(message.reply);pending.delete(message.reply);if(item)message.error?item.reject(Error(message.error)):item.resolve(message.value);return;}
 if(closed)return;
 if(message.method==='dispose'){
  closed=true;
  for(const item of pending.values())item.reject(Error('WebEngineView closed'));pending.clear();
  try{await view.dispose();}finally{parentPort.close();}return;
 }
 if(!['navigate','resize','visible','input','reload','back','forward'].includes(message.method))return;
 try{await view[message.method](...message.args);}catch(error){if(!closed)parentPort.postMessage({type:'state',state:{error:String(error.message||error)}});}
});

// Controller workers keep native networking/timers separate from QML's host globals.
import {Worker} from 'node:worker_threads';
export function createWebView({onFrame,onState,clipboard}) {
  let closed=false,exitTimer;
  let resolveExit;const exited=new Promise(resolve=>{resolveExit=resolve;});
  const worker=new Worker(new URL('./webview-worker.js',import.meta.url));
  worker.on('message',async message=>{
    if(closed)return;
    if(message.type==='frame')onFrame(message.frame);
    else if(message.type==='state')onState(message.state);
    else if(message.type==='clipboard') {
      try {const value=await (message.operation==='read'?clipboard.read():clipboard.write(message.text));if(!closed)worker.postMessage({reply:message.id,value});}
      catch(error){if(!closed)worker.postMessage({reply:message.id,error:String(error.message||error)});}
    }
  });
  worker.on('exit',()=>{clearTimeout(exitTimer);resolveExit();});
  worker.on('error',error=>{if(!closed)onState({error:String(error.message||error)});});
  const call=(method,...args)=>{if(!closed)worker.postMessage({method,args});};
  return {
    navigate:url=>call('navigate',url),resize:(w,h,dpr)=>call('resize',w,h,dpr),
    visible:value=>call('visible',value),input:(type,value)=>call('input',type,value),
    reload:()=>call('reload'),back:()=>call('back'),forward:()=>call('forward'),
    dispose(){
      if(closed)return exited;closed=true;
      // Graceful close normally kills the renderer synchronously; bound a stuck worker.
      exitTimer=setTimeout(()=>{void worker.terminate();},2000);
      try{worker.postMessage({method:'dispose',args:[]});}catch{void worker.terminate();}
      return exited;
    },
  };
}

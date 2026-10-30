export async function createDialogClient(endpoint) {
  const worker=new Worker(new URL('./dialog-worker.js',import.meta.url).href);
  await new Promise((resolve,reject)=>{
    worker.onmessage=({data})=>data.type==='ready'?resolve():reject(Error(data.message));
    worker.onerror=event=>reject(Error(event.message));
    worker.postMessage({type:'connect',endpoint});
  }).catch(error=>{worker.terminate();throw error;});
  let next=0,failed=false;const files=new Map();
  worker.onerror=()=>{failed=true;for(const resolve of files.values())resolve({accept:false});files.clear();};
  worker.onmessage=({data})=>{if(data.type==='files'){files.get(data.id)?.(data.result);files.delete(data.id);}};
  const dialog = (type,message,defaultPrompt)=>{
    if(failed)return type==='alert'?undefined:type==='confirm'?false:null;
    const buffer=new SharedArrayBuffer(12,{maxByteLength:64*1024*1024}),state=new Int32Array(buffer,0,3);
    worker.postMessage({type:'dialog',buffer,request:{type,message,defaultPrompt}});
    while(Atomics.load(state,0)===0)Atomics.wait(state,0,0);
    if(type==='alert')return undefined;
    if(type==='confirm')return Boolean(state[2]);
    if(!state[2])return null;
    const text=new Uint16Array(buffer,12,state[1]);let value='';
    for(let i=0;i<text.length;i+=8192)value+=String.fromCharCode(...text.subarray(i,i+8192));
    return value;
  };
  dialog.pickFiles=options=>new Promise(resolve=>{
    if(failed){resolve({accept:false});return;}
    const id=++next;files.set(id,resolve);
    try{worker.postMessage({type:'files',id,request:{type:'file',...options}});}
    catch{files.delete(id);resolve({accept:false});}
  });
  return dialog;
}

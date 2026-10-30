export async function createDialogClient(endpoint) {
  const worker=new Worker(new URL('./dialog-worker.js',import.meta.url).href);
  await new Promise((resolve,reject)=>{
    worker.onmessage=({data})=>data.type==='ready'?resolve():reject(Error(data.message));
    worker.onerror=event=>reject(Error(event.message));
    worker.postMessage({type:'connect',endpoint});
  }).catch(error=>{worker.terminate();throw error;});
  return (type,message,defaultPrompt)=>{
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
}

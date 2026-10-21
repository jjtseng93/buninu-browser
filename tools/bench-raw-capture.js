// Run with Bun on the host to measure capture delivery, not terminal FPS.
// Uses a local synthetic page, the normal renderer sandbox and changing crops.
import {RendererHost} from '../lib/renderer/host.js';
import {statSync,unlinkSync} from 'node:fs';
const count=Number(process.argv.find(a=>a.startsWith('--samples='))?.split('=')[1] ?? 30);
if(!Number.isInteger(count)||count<1||count>1000)throw Error('Invalid sample count');
const host=new RendererHost();
const reports=[];
try{
 await host.start();await host.call('resize',1280,690,1.5);
 await host.call('loadDocument',{url:'https://benchmark.test/',contentType:'text/html',source:'<body style="margin:0">'+Array.from({length:80},(_,i)=>`<div style="height:44px;background:rgb(${i*17%256},${i*37%256},${i*71%256})">Frame ${i} 中文 ABCDEFG 0123456789</div>`).join('')});
 await host.call('whenLoaded');await Bun.sleep(500);
 const formats=process.argv.find(a=>a.startsWith('--formats='))?.slice('--formats='.length).split(',') ?? ['png','jpeg','rgba','bgra','bgra','rgba','jpeg','png'];
 for(const format of formats){
  if(!['png','jpeg','rgba','bgra'].includes(format))throw Error('Invalid format');
  const samples=[];let bytes=0;
  for(let i=0;i<count+3;i++){
   await host.composite('scroll',0,i%2?17:-17);
   const start=performance.now();
   const data=await host.composite('screenshot',{format,quality:85,optimizeForSpeed:true});
   const ms=performance.now()-start;
   if(format==='rgba'||format==='bgra'){
    const f=JSON.parse(data);bytes=statSync(f.path).size;unlinkSync(f.path);
   }else bytes=Buffer.byteLength(data,'base64');
   if(i>=3)samples.push(ms);
  }
  samples.sort((a,b)=>a-b);
  const report={format,count,meanMs:samples.reduce((a,b)=>a+b,0)/count,medianMs:samples[Math.floor(count/2)],bytes};
  reports.push(report);console.log(JSON.stringify(report));
 }
 console.log(JSON.stringify({sandbox:host.sandbox,capture:[1920,1035],reports}));
}finally{host.close();}

import {resolve} from 'node:path';
const option=(key,value)=>process.argv.find(a=>a.startsWith(key+'='))?.slice(key.length+1)??value;
const root=resolve(option('--root','../wpt'));
const manifestPath=option('--manifest','/tmp/buninu-wpt-MANIFEST.json');
const output=option('--output','/tmp/buninu-wpt-official.json');
const perGroup=Number(option('--per-group','20')), timeout=Number(option('--timeout','15000'));
const manifest=await Bun.file(manifestPath).json();
const groups=['dom/nodes','dom/events','dom/ranges','dom/traversal','dom/collections','css/cssom','css/cssom-view','css/selectors','css/css-values','html/semantics/forms/the-input-element','html/webappapis/timers','hr-time','performance-timeline','user-timing','url','encoding','fetch','xhr','WebIDL','html/webappapis/atob','html/webappapis/microtask-queuing','html/semantics/embedded-content/the-canvas-element','html/semantics/embedded-content/media-elements','webstorage','workers','streams','webmessaging','FileAPI','html/dom','html/semantics/scripting-1'];
const all=[];
function walk(node,path=''){
 if(Array.isArray(node)){for(const [url,meta] of node.slice(1))all.push({file:'/'+(url??path).replace(/^\//,''),source:path,meta});return;}
 for(const [key,value] of Object.entries(node))walk(value,path?path+'/'+key:key);
}
walk(manifest.items.testharness);
const selected=[],excluded=[];
const sourceCache=new Map();
for(const group of groups){
 const rows=[];
 for(const item of all.filter(x=>x.source.startsWith(group+'/'))){
  // These require a browser automation bridge beyond the HTTP server.
  let source=sourceCache.get(item.source);
  if(source===undefined){source=await Bun.file(resolve(root,item.source)).text();sourceCache.set(item.source,source);}
  const reason=/testdriver(?:-vendor)?\.js|test_driver\./.test(source)?'testdriver automation bridge not implemented':null;
  if(reason){excluded.push({...item,group,reason});continue;}
  rows.push({...item,group});
 }
 rows.sort((a,b)=>a.file.localeCompare(b.file));
 const n=Math.min(perGroup,rows.length);
 for(let i=0;i<n;i++)selected.push(rows[Math.floor(i*rows.length/n)]);
}
const explicit=option('--cases',null);
if(explicit){selected.length=0;for(const name of await Bun.file(explicit).json()){const item=all.find(x=>x.file.replace(/^\//,'')===name.replace(/^\//,''));if(!item)throw Error('Not in manifest: '+name);selected.push({...item,group:'explicit'});}}
const rev=async(path)=>(await new Response(Bun.spawn(['git','-C',path,'rev-parse','HEAD'],{stdout:'pipe'}).stdout).text()).trim();
const report={revision:await rev(root),browserRevision:await rev('.'),officialManifest:manifestPath,scope:'Official wptserve; production createBrowser controller; test-only loopback routing and testharness result collector; no WebDriver bridge',started:new Date().toISOString(),deadline:timeout,manifest:selected,excluded,results:[]};
const resumePath=option('--resume',null);
const resume=resumePath?await Bun.file(resumePath).json():null;
if(resume&&(resume.revision!==report.revision||resume.browserRevision!==report.browserRevision||resume.deadline!==timeout))throw Error('Resume revision/timeout mismatch');
await Bun.write(output,JSON.stringify(report));
const children=new Set();
function stopChild(child){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill();}}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const child of children)stopChild(child);process.exit(130);});
let next=0, save=Promise.resolve();
async function worker(){
while(next<selected.length){
 const index=next++,item=selected[index];

 const scheme=/\.https\./.test(item.file)||item.meta?.https?'https':'http';
 const url=`${scheme}://web-platform.test:${scheme==='https'?18443:18000}${item.file}`;
 const resultPath=output+'.case-'+index+'.json';
 const previous=resume?.results.find(row=>row.file===item.file&&row.url===url);
 let result;
 if(previous){result={...previous,reused:true};}else{
 const child=Bun.spawn([process.execPath,resolve('test/wpt/official-case.js'),url,resultPath,String(timeout)],{stdout:'ignore',stderr:'ignore',detached:true});
 children.add(child);
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;stopChild(child);},timeout+12000);
 const code=await child.exited;clearTimeout(timer);children.delete(child);
 result=code===0&&!timedOut?await Bun.file(resultPath).json():{results:[],done:false,classification:'incomplete',runnerError:timedOut?'Runner watchdog':'Worker exited '+code};
 }
 report.results.push({...item,...result});
 const classification={};for(const row of report.results)classification[row.classification]=(classification[row.classification]??0)+1;
 const eligible=report.results.filter(r=>r.classification!=='unsupported-infrastructure');
 report.summary={files:report.results.length,classification,eligibleFiles:eligible.length,fullyPassingFiles:classification.pass??0,fullyPassingFilePercent:100*(classification.pass??0)/eligible.length};
 report.updated=new Date().toISOString();
 const snapshot=JSON.stringify(report);
 save=save.then(()=>Bun.write(output,snapshot));await save;
 console.log(`${report.results.length}/${selected.length} ${result.classification} ${item.file} ${result.ms??'?'}ms`);
}
}
await Promise.all(Array.from({length:Number(option('--jobs','2'))},()=>worker()));
console.log(JSON.stringify(report.summary));

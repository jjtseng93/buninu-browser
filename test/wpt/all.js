// Exhaustive official testharness manifest traversal; no directory/sample filter.
import {resolve} from 'node:path';
import {appendFile, mkdir, readFile, unlink} from 'node:fs/promises';
const option=(key,value)=>process.argv.find(a=>a.startsWith(key+'='))?.slice(key.length+1)??value;
const root=resolve(option('--root','../wpt'));
const manifestPath=resolve(option('--manifest','/tmp/buninu-wpt-MANIFEST.json'));
const directory=resolve(option('--output','/tmp/buninu-wpt-all'));
const jobs=Number(option('--jobs','2')),timeout=Number(option('--timeout','20000')),longTimeout=Number(option('--long-timeout','75000'));
if(!Number.isInteger(jobs)||jobs<1||!Number.isFinite(timeout)||timeout<1000||!Number.isFinite(longTimeout)||longTimeout<timeout)throw Error('Invalid jobs or timeout');
await mkdir(directory,{recursive:true});
const manifest=await Bun.file(manifestPath).json();
const all=[],types={};
function walk(node,path,type){
 if(Array.isArray(node)){
  types[type]=(types[type]??0)+node.length-1;
  if(type==='testharness')for(const [url,meta] of node.slice(1))all.push({file:'/'+(url??path).replace(/^\//,''),source:path,meta,group:path.split('/')[0]});
  return;
 }
 for(const [key,value] of Object.entries(node))walk(value,path?path+'/'+key:key,type);
}
for(const [type,node] of Object.entries(manifest.items))if(!['support','spec'].includes(type))walk(node,'',type);
all.sort((a,b)=>a.file.localeCompare(b.file));
const rev=async(path)=>(await new Response(Bun.spawn(['git','-C',path,'rev-parse','HEAD'],{stdout:'pipe'}).stdout).text()).trim();
const hash=async(path)=>new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
const signature={revision:await rev(root),browserRevision:await rev('.'),caseRunner:await hash(resolve('test/wpt/official-case.js')),runner:await hash(resolve('test/wpt/all.js')),manifestHash:await hash(manifestPath),domainsHash:await hash(new URL('./domains.json',import.meta.url)),shard:option('--shard','0/1'),runtime:{platform:process.platform,arch:process.arch,bun:Bun.version,revision:Bun.revision},timeout,longTimeout};
const metaPath=resolve(directory,'manifest.json'), resultsPath=resolve(directory,'results.jsonl');
let previous=[];
if(await Bun.file(metaPath).exists()){
 const old=await Bun.file(metaPath).json();
 if(JSON.stringify(old.signature)!==JSON.stringify(signature))throw Error('Resume requires identical browser/WPT/runner/manifest/timeouts; use another output directory');
 const lines=(await readFile(resultsPath,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;})).split('\n').filter(Boolean);
 previous=lines.map(line=>JSON.parse(line));
}else{
 await Bun.write(metaPath,JSON.stringify({signature,scope:'All official testharness manifest cases, no sampling. Other manifest types require separate adapters.',types,total:all.length,cases:all,started:new Date().toISOString()},null,2));
}
const seen=new Set(previous.map(x=>x.file));
const shard=option('--shard','0/1').split('/').map(Number);
if(shard.length!==2||!shard.every(Number.isInteger)||shard[0]<0||shard[1]<1||shard[0]>=shard[1])throw Error('Invalid --shard=index/count');
const assigned=all.filter((_,index)=>index%shard[1]===shard[0]);
const selected=assigned.filter(x=>!seen.has(x.file));
const classification={},limitations={};let completed=0,subtests=0,passedSubtests=0;
function count(row){completed++;classification[row.classification]=(classification[row.classification]??0)+1;for(const reason of new Set(row.infrastructure??[]))limitations[reason]=(limitations[reason]??0)+1;subtests+=row.results?.length??0;passedSubtests+=row.results?.filter(t=>t.status===0).length??0;}
for(const row of previous)count(row);
const started=Date.now(),initial=completed;
const children=new Set();
function stopChild(child){try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill();}catch{}}}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const child of children)stopChild(child);process.exit(130);});
let next=0,save=Promise.resolve();
async function worker(workerId){
 while(next<selected.length){
  const item=selected[next++];
  const scheme=/\.https\.|\.serviceworker\./.test(item.file)||item.meta?.https?'https':'http';
  const url=`${scheme}://web-platform.test:${scheme==='https'?18443:18000}${item.file}`;
  const budget=item.meta?.timeout==='long'?longTimeout:timeout;
  const resultPath=resolve(directory,`worker-${workerId}.json`);
  const logPath=resolve(directory,`worker-${workerId}.log`);
  const child=Bun.spawn([process.execPath,resolve('test/wpt/official-case.js'),url,resultPath,String(budget)],{stdout:'ignore',stderr:Bun.file(logPath),detached:true});
  children.add(child);let expired=false;
  const timer=setTimeout(()=>{expired=true;stopChild(child);},budget+12000);
  const code=await child.exited;clearTimeout(timer);children.delete(child);
  // Clean up a descendant even when a crashed parent exited before its renderer.
  if(code!==0)stopChild(child);
  let result;
  try{result=code===0&&!expired?await Bun.file(resultPath).json():{results:[],done:false,classification:'incomplete',runnerError:expired?'Runner watchdog':'Worker exited '+code,stderr:(await Bun.file(logPath).text()).slice(-4000)};}
  catch(error){result={results:[],done:false,classification:'incomplete',runnerError:String(error)};}
  if(item.meta?.pac){result.infrastructure=[...(result.infrastructure??[]),'PAC proxy setup: '+item.meta.pac];result.classification='unsupported-infrastructure';}
  const row={...item,...result,url};
  save=save.then(async()=>{
   await appendFile(resultsPath,JSON.stringify(row)+'\n');count(row);
   const eligible=completed-(classification['unsupported-infrastructure']??0);
   const totalManifest=Object.values(types).reduce((a,b)=>a+b,0);
   const elapsed=(Date.now()-started)/1000;
   await Bun.write(resolve(directory,'progress.json'),JSON.stringify({updated:new Date().toISOString(),total:assigned.length,wholeTestharness:all.length,shard,completed,remaining:assigned.length-completed,classification,limitations,reportedSubtests:subtests,passedSubtests,eligible,passed:classification.pass??0,testedPassPercent:eligible?100*(classification.pass??0)/eligible:0,wholeManifestCases:totalManifest,wholeManifestVerifiedPassPercent:100*(classification.pass??0)/totalManifest,elapsedSeconds:elapsed,newCases:completed-initial,estimatedRemainingHours:completed>initial?elapsed/(completed-initial)*(assigned.length-completed)/3600:null},null,2));
   console.log(`${completed}/${all.length} ${row.classification} ${item.file} ${row.ms??'?'}ms`);
  });await save;
  await unlink(resultPath).catch(()=>{});
 }
}
console.log(`Full manifest: ${all.length} testharness cases; shard ${shard.join("/")} has ${assigned.length}; ${previous.length} already complete; ${jobs} workers`);
await Promise.all(Array.from({length:jobs},(_,i)=>worker(i)));
console.log('All testharness cases attempted. See progress.json and results.jsonl.');

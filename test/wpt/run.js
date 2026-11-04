import { resolve, dirname, extname, sep } from 'node:path';
import { RendererHost } from '../../lib/renderer/host.js';

// Lightweight static testharness runner, not a replacement for wptrunner.
const args = process.argv.slice(2);
const option = (key, fallback) => args.find(a => a.startsWith(key+'='))?.slice(key.length+1) ?? fallback;
const root = resolve(option('--root', '../wpt'));
const output = resolve(option('--output', '/tmp/buninu-wpt-results.json'));
const perGroup = Number(option('--per-group', '10'));
const deadline = Number(option('--timeout', '15000'));
const manifestPath=option('--manifest',resolve(root,'MANIFEST.json'));
if(!await Bun.file(manifestPath).exists())throw Error('Generate an official WPT manifest first and pass --manifest=/path/MANIFEST.json (see test/wpt/README.md)');
const official=await Bun.file(manifestPath).json();
const resumePath=option('--resume',null);
const resume=resumePath?await Bun.file(resumePath).json():null;
const groups = ['dom/nodes','dom/events','dom/ranges','dom/traversal','dom/collections',
  'css/cssom','css/cssom-view','css/selectors','css/css-values','html/semantics/forms/the-input-element',
  'html/webappapis/timers','hr-time','performance-timeline','user-timing','url','encoding'];
const collector = `\n;(() => {
  const results=[]; window.__buninuWpt={results,done:false};
  add_result_callback(t=>results.push({name:t.name,status:t.status,message:t.message,stack:t.stack}));
  add_completion_callback((tests,status)=>{window.__buninuWpt.status={status:status.status,message:status.message};window.__buninuWpt.done=true;});
})();\n`;
const manifest = [], skipped = [], counts = {};
const revisionProcess = Bun.spawn(['git','-C',root,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});
const revision = (await new Response(revisionProcess.stdout).text()).trim();
if(await revisionProcess.exited) throw Error('WPT root must be an existing Git checkout');
for (const group of groups) {
  const files = [...new Bun.Glob('**/*').scanSync({cwd:resolve(root,group),onlyFiles:true})].sort();
  const eligible = [];
  for (const path of files) {
    const name=group+'/'+path;
    if(!/\.html?$/.test(name)) continue;
    const source=await Bun.file(resolve(root,name)).text();
    if(!/<script[^>]+src=["']?[^\s>"']*testharness\.js/i.test(source)) continue;
    let officialEntry=official?.items?.testharness;
    if(official)for(const part of name.split('/'))officialEntry=officialEntry?.[part];
    const reason=official && (!Array.isArray(officialEntry)||officialEntry.length!==2)?'not a single official testharness case':/\.(?:sub|manual|https)\./.test(name)?'templated/manual/HTTPS document':
      /testdriver(?:-vendor)?\.js/.test(source)?'testdriver automation required':
      /<meta[^>]+name=["']?variant/i.test(source)?'URL variants require official runner':null;
    if(reason){skipped.push({file:name,reason});continue;}
    eligible.push(name);
  }
  counts[group]={eligible:eligible.length,selected:Math.min(perGroup,eligible.length)};
  // Evenly spaced sorted sample, determined before any execution/results.
  for(let i=0;i<Math.min(perGroup,eligible.length);i++){
    manifest.push({group,file:eligible[Math.floor(i*eligible.length/Math.min(perGroup,eligible.length))]});
  }
}
const headerCache = new Map();
async function headerFile(file) {
  if(headerCache.has(file))return headerCache.get(file);
  const candidates=[file+'.headers'];
  for(let dir=dirname(file);dir===root||dir.startsWith(root+sep);dir=dirname(dir))candidates.push(resolve(dir,'__dir__.headers'));
  let found=null;
  for(const candidate of candidates)if(await Bun.file(candidate).exists()){found=candidate;break;}
  headerCache.set(file,found);return found;
}
const report={revision,browserRevision:(await new Response(Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe'}).stdout).text()).trim(),
  started:new Date().toISOString(),scope:'Static HTML testharness sample; no generated .any/.window tests, reftests, testdriver, server templates or Python handlers.',
  deadline,counts,excluded:skipped,manifest,results:[]};
if(resume && (resume.revision!==revision || resume.browserRevision!==report.browserRevision || resume.deadline!==deadline))throw Error('Resume requires matching WPT/browser commits and timeout');
report.officialManifest=manifestPath;
await Bun.write(output,JSON.stringify(report,null,2));
let active;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{active?.close();process.exit(130);});
for(const item of manifest){
  const previous=resume?.results.find(row=>row.file===item.file);
  if(previous){
    report.results.push({...previous,reused:true});report.summary=summarize(report.results);
    await Bun.write(output,JSON.stringify(report,null,2));
    console.log(`${report.results.length}/${manifest.length} reused ${previous.classification} ${item.file}`);continue;
  }
  const started=performance.now(), unsupported=[], errors=[];
  const host=new RendererHost({timeout:Math.min(deadline,10000),fetch:async(url,init={})=>{
    const parsed=new URL(url), pathname=decodeURIComponent(parsed.pathname);
    const file=resolve(root,'.'+pathname);
    if(!file.startsWith(root+sep)||!['http:','https:'].includes(parsed.protocol)) return new Response('blocked',{status:403});
    if(parsed.hostname!=='web-platform.test' || /\.(py|asis)$/.test(pathname) || pathname.includes('.sub.') || parsed.searchParams.has('pipe')){
      unsupported.push(parsed.href);return new Response('WPT server feature not supported by static runner',{status:501});
    }
    if((init.method??'GET')!=='GET'){unsupported.push(parsed.href);return new Response('',{status:501});}
    const specialHeaders=await headerFile(file);
    const extraHeaders={};
    if(specialHeaders){
      const headerText=await Bun.file(specialHeaders).text();
      for(const line of headerText.split(/\r?\n/).filter(line=>line.trim())){
        const pair=/^([^:]+):\s*(.*)$/.exec(line);
        if(!pair || line.includes('{{') || !['content-type','cache-control'].includes(pair[1].toLowerCase())){
          unsupported.push(specialHeaders);return new Response('WPT response headers require official server',{status:501});
        }
        extraHeaders[pair[1].toLowerCase()]=pair[2];
      }
    }
    const f=Bun.file(file);if(!await f.exists()) {errors.push(parsed.href);return new Response('not found',{status:404});}
    const type={'.js':'text/javascript','.html':'text/html','.htm':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.xml':'application/xml','.idl':'text/plain'}[extname(file)]??f.type;
    return new Response(pathname==='/resources/testharness.js'?await f.text()+collector:f,{headers:{'content-type':type,...extraHeaders}});
  }});active=host;
  let result={...item,results:[],done:false};
  try{
    const mainHeaders=await headerFile(resolve(root,item.file));
    if(mainHeaders){unsupported.push(mainHeaders);throw Error('Document requires WPT response headers');}
    await host.start();await host.call('resize',800,600,1);
    await host.call('loadDocument',{url:'http://web-platform.test/'+item.file,source:await Bun.file(resolve(root,item.file)).text(),contentType:'text/html',status:200});
    while(performance.now()-started<deadline){
      const state=await host.call('evaluate','window.__buninuWpt ? JSON.stringify(window.__buninuWpt) : null');
      if(state)Object.assign(result,JSON.parse(state));
      if(result.done)break;
      await Bun.sleep(50);
    }
    if(!result.done)result.runnerError='deadline exceeded';
  }catch(error){result.runnerError=String(error);}
  finally{host.close();active=null;}
  result.unsupported=[...new Set(unsupported)];result.missing=[...new Set(errors)];result.ms=Math.round(performance.now()-started);
  result.classification=unsupported.length?'unsupported-infrastructure':result.runnerError?'incomplete':result.status?.status!==0?'harness-error':result.results.every(t=>t.status===0)?'pass':'fail';
  report.results.push(result);
  report.summary=summarize(report.results);report.updated=new Date().toISOString();
  await Bun.write(output,JSON.stringify(report,null,2));
  console.log(`${report.results.length}/${manifest.length} ${result.classification} ${result.results.filter(t=>t.status===0).length}/${result.results.length} ${item.file} (${result.ms}ms)`);
}
console.log(JSON.stringify(report.summary,null,2));
function summarize(rows){
 const classification={};for(const row of rows)classification[row.classification]=(classification[row.classification]??0)+1;
 const eligible=rows.filter(r=>r.classification!=='unsupported-infrastructure');
 const tests=eligible.flatMap(r=>r.results),pass=tests.filter(t=>t.status===0).length;
 return {files:rows.length,classification,reportedSubtests:tests.length,passedSubtests:pass,reportedSubtestPassPercent:tests.length?100*pass/tests.length:null,
   eligibleFiles:eligible.length,fullyPassingFiles:classification.pass??0,fullyPassingFilePercent:eligible.length?100*(classification.pass??0)/eligible.length:null,
   warning:'Subtest percentage covers reported subtests only. Incomplete files can contain unreported tests; file percentage retains incomplete files as nonpasses. Not overall WPT compliance.'};
}

import {createBrowser} from '../../lib/headless-shell.js';
import {NetworkService} from '../../lib/network/network-service.js';
const [url, output, timeout='15000']=process.argv.slice(2);
const collector=`\n;(()=>{const results=[];globalThis.__buninuWpt={results,done:false};add_result_callback(t=>results.push({name:t.name,status:t.status,message:t.message}));add_completion_callback((tests,status)=>{globalThis.__buninuWpt.status={status:status.status,message:status.message};globalThis.__buninuWpt.done=true;});})();`;
const infrastructure=[], networkErrors=[];
const domainConfig=await Bun.file(new URL('./domains.json',import.meta.url)).json();
const domains=new Set(domainConfig.domains),missingDomains=new Set(domainConfig.notDomains);
// Official vendor file is empty: only flag automation when actually invoked.
const driverProbe=`;(()=>{const visit=(object,prefix)=>{for(const key of Object.keys(object)){const value=object[key],name=prefix+key;if(typeof value==='function')object[key]=function(){(globalThis.__buninuWptUnsupported??=[]).push('testdriver: '+name);fetch('/__buninu_wpt__/unsupported',{method:'POST',body:'testdriver: '+name}).catch(()=>{});throw new Error('WPT adapter has no automation command: '+name);};else if(value&&typeof value==='object')visit(value,name+'.');}};if(globalThis.test_driver_internal){visit(globalThis.test_driver_internal,'');globalThis.test_driver_internal.in_automation=true;}})();`;

let browser;
const result={url,results:[],done:false};
const started=performance.now();
try {
 const network=new NetworkService({fetch:async(input,init={})=>{
  const original=new URL(input), target=new URL(input);
  if(original.pathname==='/__buninu_wpt__/unsupported'){infrastructure.push(typeof init.body==='string'?init.body:new TextDecoder().decode(init.body));return new Response('ok');}
  if(missingDomains.has(original.hostname)||original.hostname.endsWith('.invalid'))throw new TypeError('Expected nonexistent test domain');
  if(!domains.has(original.hostname)&&!['127.0.0.1','localhost','[::1]'].includes(original.hostname)) {
   infrastructure.push('Unmapped host: '+original.hostname);throw Error('Unmapped WPT host');
  }
  target.hostname='127.0.0.1';
  const headers=new Headers(init.headers);headers.set('host',original.host);
  try {
   const response=await fetch(target,{...init,headers,redirect:'manual',tls:{rejectUnauthorized:false}});
   if(['/resources/testharness.js','/resources/testdriver.js'].includes(original.pathname)){
    const h=new Headers(response.headers);h.delete('content-length');h.delete('content-encoding');
    return new Response(await response.text()+(original.pathname.endsWith("testdriver.js")?driverProbe:collector),{status:response.status,headers:h});
   }
   return response;
  } catch(error){networkErrors.push({url:String(input),error:String(error)});throw error;}
 }});
 browser=await createBrowser({network,spareRenderer:false,rendererTimeout:Number(timeout)});
 await browser.context.navigate(url);
 while(performance.now()-started<Number(timeout)){
  const state=await browser.context.evaluate('globalThis.__buninuWpt ? JSON.stringify(globalThis.__buninuWpt) : null');
  if(state)Object.assign(result,JSON.parse(state));
  const unsupported=await browser.context.evaluate('JSON.stringify(globalThis.__buninuWptUnsupported||[])');
  if(unsupported)infrastructure.push(...JSON.parse(unsupported));
  if(result.done)break;
  await Bun.sleep(50);
 }
 if(!result.done)result.runnerError='Case deadline exceeded';
} catch(error){result.runnerError=String(error);}
finally {browser?.close();}
result.runtime={platform:process.platform,arch:process.arch,bun:Bun.version,revision:Bun.revision};result.infrastructure=[...new Set(infrastructure)];result.networkErrors=networkErrors;result.ms=Math.round(performance.now()-started);
result.classification=infrastructure.length?'unsupported-infrastructure':result.runnerError?'incomplete':result.status?.status!==0?'harness-error':result.results.every(t=>t.status===0)?'pass':'fail';
await Bun.write(output,JSON.stringify(result));
process.exit(0);

// Isolate module/timer mocks from the real renderer integration tests.
import {mock} from 'bun:test';
import {strict as assert} from 'node:assert';

let now=0,nextPid=100,heldPid=null;
const timers=new Set(),hosts=[];
const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
globalThis.setTimeout=(callback,delay,...args)=>{
  if(delay!==1000&&delay!==30000)return originalSetTimeout(callback,delay,...args);
  const timer={at:now+delay,callback:()=>callback(...args),unref(){}};
  timers.add(timer);return timer;
};
globalThis.clearTimeout=timer=>{if(!timers.delete(timer))originalClearTimeout(timer);};
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const advance=async milliseconds=>{
  now+=milliseconds;
  for(const timer of [...timers].sort((a,b)=>a.at-b.at))if(timer.at<=now&&timers.delete(timer))timer.callback();
  await flush();
};
class FakeHost {
  constructor(options){this.options=options;this.pid=nextPid++;this.generation=0;this.closed=false;hosts.push(this);}
  start(){
    if(!this.ready){
      if(this.pid===heldPid){this.opening=Promise.withResolvers();this.ready=this.opening.promise;}
      else this.ready=Promise.resolve();
    }
    return this.ready;
  }
  close(){this.closed=true;}
  lifecycle(name,generation=this.generation){this.options.onLifecycle(name,generation);}
  async call(method,...args){
    if(method==='loadDocument'){
      this.documentUrl=args[0].url;const generation=++this.generation;
      this.lifecycle('DOMContentLoaded',generation);
      if(!this.documentUrl.endsWith('/slow'))this.lifecycle('load',generation);
      return generation;
    }
    if(method==='title')return this.documentUrl;
  }
  async composite(){return{x:0,y:0};}
}
mock.module('../../lib/renderer/host.js',()=>({RendererHost:FakeHost}));
const {createBrowser}=await import('../../lib/headless-shell.js');
const network={
  documentCookie:()=>'',
  navigate:async url=>({url,body:new TextEncoder().encode('<title>ok</title>'),contentType:'text/html',status:200,statusText:'OK'}),
};
const hostFor=browser=>hosts.find(host=>host.pid===browser.rendererPid);
const browsers=[];
try{
  const browser=await createBrowser({network});browsers.push(browser);
  assert.equal(hosts.length,2,'first navigation retains its parallel warmed spare');
  const first=hostFor(browser),initialSpare=browser.sparePid;
  await browser.context.navigate('https://one.test/slow');
  assert.equal(browser.rendererPid,initialSpare);
  assert.equal(browser.sparePid,null);
  assert.equal(hosts.length,2,'committing a loading page does not immediately start another renderer');
  assert.ok(first.closed,'cross-origin navigation closes the previous origin');
  await advance(1000);
  assert.equal(hosts.length,2);
  hostFor(browser).lifecycle('load');
  await advance(999);
  assert.equal(browser.sparePid,null);
  await advance(1);
  assert.equal(hosts.length,3,'load schedules spare startup after one second');
  const sameOrigin=browser.rendererPid,spare=browser.sparePid;
  await browser.context.navigate('https://one.test/fast');
  assert.equal(browser.rendererPid,sameOrigin);
  assert.equal(browser.sparePid,spare,'same-origin navigation retains an existing spare');

  await browser.context.navigate('https://two.test/slow');
  assert.equal(browser.rendererPid,spare);
  assert.ok(hosts.find(host=>host.pid===sameOrigin).closed);
  await advance(29999);
  assert.equal(browser.sparePid,null);
  await advance(1);
  assert.equal(hosts.length,4,'a missing load event has a bounded fallback');

  await browser.context.navigate('https://three.test/slow');
  const active=hostFor(browser),oldGeneration=active.generation;
  await advance(500);
  await browser.context.navigate('https://three.test/fast');
  assert.equal(hostFor(browser),active,'same-origin navigation keeps its process');
  const latestTimer=[...timers][0];
  active.lifecycle('load',oldGeneration);
  assert.equal([...timers][0],latestTimer,'a late previous-generation load does not rearm the timer');
  await advance(1000);
  assert.equal(hosts.length,5,'load observed before commit is also respected');
  await browser.context.navigate('https://four.test/slow');
  browser.close();
  const beforeClose=hosts.length;
  await advance(30000);
  assert.equal(hosts.length,beforeClose,'closing cancels pending prewarming');
  assert.equal(timers.size,0);

  const disabled=await createBrowser({network,spareRenderer:false});browsers.push(disabled);
  const beforeDisabled=hosts.length;
  await disabled.context.navigate('https://disabled.test/fast');
  await advance(60000);
  assert.equal(hosts.length,beforeDisabled+1);
  assert.equal(disabled.sparePid,null);
  disabled.close();

  // An old spare can be acquired while still starting, then superseded by a
  // second navigation. Its eventual rejection must not clear the new spare.
  heldPid=nextPid+1;
  const competing=await createBrowser({network});browsers.push(competing);
  const oldSpare=hosts.find(host=>host.pid===heldPid);
  const failedNavigation=competing.context.navigate('https://failed.test/slow').then(()=>null,error=>error);
  await flush();
  await competing.context.navigate('https://replacement.test/fast');
  await advance(1000);
  const replacementSpare=competing.sparePid;
  assert.ok(replacementSpare!==null);
  oldSpare.opening.reject(Error('expected startup failure'));
  assert.match(String(await failedNavigation),/expected startup failure/);
  assert.equal(competing.sparePid,replacementSpare);
  assert.equal(hosts.find(host=>host.pid===replacementSpare).closed,false);
  competing.close();
  process.stdout.write('spare scheduling lifecycle, isolation, cancellation and failure checks passed\n');
}finally{
  for(const browser of browsers)browser.close();
  globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
}

import '../../vendor/ses/dist/ses.mjs';
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {prepareModuleSource} from '../../lib/renderer/module-preparation.js';

const sleep=Bun.sleep, errors=[], navigations=[];
const delayedRewrite=Promise.withResolvers(), rewriteStarted=Promise.withResolvers();
const delayedFetch=Promise.withResolvers(), fetchStarted=Promise.withResolvers();
const tlaStarted=Promise.withResolvers();
let heldSource=null, rewritten=0;
const resource=(url,source)=>({ok:true,url,contentType:'text/javascript',body:new TextEncoder().encode(source)});
const renderer=await createPageRenderer({
  reportError:error=>errors.push(String(error)),
  requestNavigation:url=>navigations.push(url),
  consoleMessage(_level,text){if(String(text).includes('TLA_STARTED'))tlaStarted.resolve();},
  rewriteScript(source,options){
    rewritten++;
    if(source.includes('DELAYED_REWRITE')){
      heldSource={source,mode:options.mode};rewriteStarted.resolve();return delayedRewrite.promise;
    }
    return Promise.resolve(prepareModuleSource(source,options.mode));
  },
  fetchResource(url){
    if(url.endsWith('/slow.js')){fetchStarted.resolve();return delayedFetch.promise;}
    if(url.endsWith('/tla.js'))return Promise.resolve(resource(url,"console.log('TLA_STARTED');await new Promise(()=>{});location.href='https://stale.test/tla';"));
    throw Error(`Unexpected resource: ${url}`);
  },
});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});

// Only the test has a deadline. Document disposal must settle the old load
// without waiting for the worker/network/TLA to complete at all.
async function settled(pending,label){
  let timer;
  try{await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} did not settle after disposal`)),2000);})]);}
  finally{clearTimeout(timer);}
}
async function replace(oldLoad){
  await renderer.loadDocument({url:'https://module.test/replacement',source:'<!doctype html><p>Replacement</p>'});
  await settled(oldLoad,'Old module load');
  await renderer.whenLoaded();
}
try{
  renderer.resize(100,100,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://module.test/rewrite',source:"<script type=module>/* DELAYED_REWRITE */location.href='https://stale.test/rewrite';</script>"});
  let oldLoad=renderer.whenLoaded();
  await rewriteStarted.promise;
  await replace(oldLoad);
  delayedRewrite.resolve(prepareModuleSource(heldSource.source,heldSource.mode));
  await sleep(20);
  assert.deepEqual(navigations,[],'late worker result must not execute the disposed module');

  await renderer.loadDocument({url:'https://module.test/fetch',source:"<script type=module>import './slow.js';location.href='https://stale.test/importer';</script>"});
  oldLoad=renderer.whenLoaded();
  await fetchStarted.promise;
  await replace(oldLoad);
  const before=rewritten;
  delayedFetch.resolve(resource('https://module.test/slow.js',"location.href='https://stale.test/fetch';"));
  await sleep(20);
  assert.equal(rewritten,before,'late source must not enter preparation after disposal');
  assert.deepEqual(navigations,[]);

  await renderer.loadDocument({url:'https://module.test/await',source:"<script type=module>import './tla.js';location.href='https://stale.test/after-tla';</script>"});
  oldLoad=renderer.whenLoaded();
  await tlaStarted.promise;
  await replace(oldLoad);
  assert.deepEqual(navigations,[],'an importer suspended behind cancelled TLA must not execute');
  assert.deepEqual(errors,[],'disposal is not a page script error');
  process.stdout.write('module disposal passed\n');
}finally{renderer.dispose();}

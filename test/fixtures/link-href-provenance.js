import {isDeepStrictEqual} from 'node:util';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

// SES freezes Error.stackTraceLimit, which Node's AssertionError tries to set.
function equal(actual,expected,label){
  if(!isDeepStrictEqual(actual,expected))throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function check(condition,label){if(!condition)throw new Error(label);}
const original=StyleEngine.prototype.compute;
let engine=null,passes=[];
StyleEngine.prototype.compute=function(...args){
  engine??=this;
  const result=original.apply(this,args);
  if(this===engine&&args[5]?.size)passes.push({restyled:this.restyled,scoped:args[6]?.reuseUnchangedShadowScopes===true});
  return result;
};
const responses=new Map(),requests=[],errors=[];
const css=(url,text)=>({ok:true,status:200,url,contentType:'text/css',body:new TextEncoder().encode(text)});
function hold(path){
  const response=Promise.withResolvers(),started=Promise.withResolvers();
  responses.set(path,{response,started});
  return {started:started.promise,finish:text=>response.resolve(css(`https://link-provenance.test${path}`,text))};
}
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error)),
  fetchResource(url,kind){
    equal(kind,'stylesheet','only stylesheet links enter the CSS loader');
    const path=new URL(url).pathname;requests.push(path);
    const held=responses.get(path);
    if(held){held.started.resolve();return held.response.promise;}
    return Promise.resolve(css(url,path==='/green.css'?'#target{color:green}':
      path==='/scope-a.css'?'.value{color:red}':'#target{color:red}'));
  },
});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const run=source=>renderer.evaluate(source);
async function change(source,label,mode='any'){
  passes=[];
  const result=await run(source);
  await renderer.screenshot();
  equal(errors,[],`${label}: full style oracle`);
  if(mode==='retained'||mode==='scoped')check(passes.every(pass=>pass.restyled<60),`${label}: unexpectedly restyled document ${JSON.stringify(passes)}`);
  if(mode==='scoped')check(passes.some(pass=>pass.scoped),`${label}: missing owning-scope refresh`);
  if(mode==='unknown')check(passes.some(pass=>!pass.scoped&&pass.restyled>=120),`${label}: independent unknown state must stay conservative`);
  return result;
}
try{
  renderer.resize(320,240,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://link-provenance.test/',contentType:'text/html',source:`<!doctype html>
    <style>body{margin:0;color:black}#target{color:black}
    main:has(link[href$="two.ico"]){background:yellow}link[href$="two.ico"]+b{color:blue}</style>
    <link id="sheet" rel="stylesheet" href="/red.css">
    <main><link id="icon" rel="icon" href="/one.ico"><b id="label">Icon label</b></main>
    <div id="target">Document</div><article id="host"><a id="anchor" href="/one">Anchor</a></article>
    <aside>${'<div>Unrelated</div>'.repeat(120)}</aside>`});
  await renderer.whenLoaded();
  await run(`globalThis.sheet=document.getElementById('sheet');globalThis.icon=document.getElementById('icon');
    globalThis.target=document.getElementById('target');globalThis.host=document.getElementById('host');
    globalThis.anchor=document.getElementById('anchor');globalThis.root=host.attachShadow({mode:'closed'});
    root.innerHTML='<style>.value{color:black}</style><link rel="stylesheet"><div class="value">Scoped</div><slot></slot>';
    globalThis.scopedLink=root.querySelector('link');globalThis.value=root.querySelector('.value');
    globalThis.scopeLoaded=new Promise(resolve=>scopedLink.addEventListener('load',()=>resolve(true),{once:true}));
    scopedLink.href='/scope-a.css';getComputedStyle(value).color`);
  equal(await run(`scopeLoaded.then(()=>getComputedStyle(value).color)`),'rgb(255, 0, 0)','initial scoped stylesheet');
  await renderer.screenshot();equal(errors,[],'initial style oracle');
  equal(await run(`getComputedStyle(target).color`),'rgb(255, 0, 0)','initial document stylesheet');

  const beforeIcon=requests.length;
  equal(await change(`icon.href='/two.ico';[icon.getAttribute('href'),icon.href,
    getComputedStyle(document.getElementById('label')).color,getComputedStyle(icon.parentElement).backgroundColor]`,
    'icon href is a reflected attribute','retained'),
    ['/two.ico','https://link-provenance.test/two.ico','rgb(0, 0, 255)','rgb(255, 255, 0)']);
  equal(requests.length,beforeIcon,'icon href is not a stylesheet request');

  const blue=hold('/blue.css');
  equal(await change(`globalThis.loads=[];sheet.addEventListener('load',()=>loads.push(sheet.getAttribute('href')));
    globalThis.blueLoaded=new Promise(resolve=>sheet.addEventListener('load',()=>resolve(true),{once:true}));
    sheet.href='/blue.css';getComputedStyle(target).color`,'pending document replacement removes old CSS'),'rgb(0, 0, 0)');
  await blue.started;
  blue.finish('#target{color:blue}');
  equal(await change(`blueLoaded.then(()=>getComputedStyle(target).color)`,'new document stylesheet applies'),'rgb(0, 0, 255)');
  equal(requests.filter(path=>path==='/blue.css').length,1,'new href fetched once');

  const obsolete=hold('/obsolete.css');
  equal(await change(`sheet.href='/obsolete.css';getComputedStyle(target).color`,'second pending replacement removes old CSS'),'rgb(0, 0, 0)');
  await obsolete.started;
  await run(`globalThis.greenLoaded=new Promise(resolve=>sheet.addEventListener('load',()=>resolve(true),{once:true}));
    sheet.href='/green.css';getComputedStyle(target).color`);
  equal(await change(`greenLoaded.then(()=>getComputedStyle(target).color)`,'newer request wins'),'rgb(0, 128, 0)');
  const completedLoads=await run(`loads.slice()`);
  obsolete.finish('#target{color:purple}');
  await new Promise(resolve=>setTimeout(resolve,0));
  equal(await change(`getComputedStyle(target).color`,'obsolete response cannot replace current sheet'),'rgb(0, 128, 0)');
  equal(await run(`loads.slice()`),completedLoads,'obsolete response cannot fire a new load event');

  const scopedBlue=hold('/scope-b.css');
  equal(await change(`globalThis.scopedLoaded=new Promise(resolve=>scopedLink.addEventListener('load',()=>resolve(true),{once:true}));
    scopedLink.href='/scope-b.css';getComputedStyle(value).color`,'pending scoped replacement removes only owning sheet','scoped'),'rgb(0, 0, 0)');
  await scopedBlue.started;
  scopedBlue.finish('.value{color:blue}');
  equal(await change(`scopedLoaded.then(()=>getComputedStyle(value).color)`,'new scoped stylesheet applies','scoped'),'rgb(0, 0, 255)');
  equal(await run(`getComputedStyle(target).color`),'rgb(0, 128, 0)','scoped CSS never enters document cascade');

  await change(`host.normalize();icon.href='/three.ico';getComputedStyle(value).color`,
    'unknown state followed by link href','unknown');
  await change(`icon.href='/four.ico';host.normalize();getComputedStyle(value).color`,
    'link href followed by unknown state','unknown');
  await change(`anchor.href='/two';getComputedStyle(value).color`,
    'other href setters retain their original state notification','unknown');
  equal(errors,[],'final style oracle');
}finally{
  for(const [path,entry] of responses)entry.response.resolve(css(`https://link-provenance.test${path}`,''));
  renderer.dispose();
}

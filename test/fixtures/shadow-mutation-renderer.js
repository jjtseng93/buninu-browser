import {strict as assert} from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

const original=StyleEngine.prototype.compute;
let rendererEngine=null,passes=[];
StyleEngine.prototype.compute=function(...args){
  rendererEngine??=this;
  const result=original.apply(this,args);
  if(this===rendererEngine&&args[5]?.size)passes.push({restyled:this.restyled,full:!this.incremental,
    requested:args[6]?.reuseUnchangedShadowScopes===true,hosts:args[6]?.scopedMutationHosts?.size??0});
  return result;
};
const errors=[];
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error))});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const run=source=>renderer.evaluate(source);
const source=`<!doctype html><style>body{margin:0}section{color:black}article{display:block}</style>
  <section id="outer"><article id="a"><span id="light">Light</span></article><article id="b"></article></section>
  <aside>${'<div>Unrelated</div>'.repeat(120)}</aside>`;
async function load(){
  await renderer.loadDocument({url:'https://scope-mutation.test/',contentType:'text/html',source});
  await renderer.whenLoaded();
  assert.deepEqual(errors,[],'each navigation creates a fresh page realm');
  await run(`globalThis.outer=document.getElementById('outer');globalThis.a=document.getElementById('a');
    globalThis.b=document.getElementById('b');globalThis.light=document.getElementById('light');`);
}
async function setup(){
  await load();
  await run(`globalThis.ra=a.attachShadow({mode:'closed',slotAssignment:'manual'});
    globalThis.rb=b.attachShadow({mode:'closed',slotAssignment:'manual'});
    ra.innerHTML='<style>:host{color:black}:host([title=blue]){color:blue}.item{color:inherit}.fallback{display:block;height:17px;color:red}::slotted(.green){color:green}</style><div class="item"><slot><span class="fallback">Fallback A</span></slot></div>';
    rb.innerHTML='<style>:host{color:purple}.fallback{display:block;height:19px}</style><slot><span class="fallback">Fallback B</span></slot>';
    globalThis.sa=ra.querySelector('slot');globalThis.sb=rb.querySelector('slot');sa.assign(light);
    getComputedStyle(a).color`);
  await renderer.screenshot();assert.deepEqual(errors,[]);
}
async function scoped(script,label,minHosts=1){
  passes=[];
  const result=await run(script);
  await renderer.screenshot();
  assert.ok(passes.some(pass=>pass.requested&&pass.hosts>=minHosts&&pass.restyled<60),`${label}: retain unrelated styles ${JSON.stringify(passes)}`);
  assert.deepEqual(errors,[],`${label}: styles match full traversal`);
  return result;
}
async function unknown(script,label){
  passes=[];
  const result=await run(script);
  await renderer.screenshot();
  assert.ok(passes.some(pass=>pass.full&&!pass.requested&&pass.restyled>=120),`${label}: independent unknown marker ${JSON.stringify(passes)}`);
  assert.deepEqual(errors,[],`${label}: styles match full traversal`);
  return result;
}
try{
  renderer.resize(320,200,1);renderer.setScripting('ses');await setup();
  assert.equal(await scoped(`a.title='blue';getComputedStyle(ra.querySelector('.item')).color`,'standard reflected host attribute'),'rgb(0, 0, 255)');
  assert.equal(await scoped(`a.setAttribute('title','black');getComputedStyle(a).color`,'host attribute removal of selector match'),'rgb(0, 0, 0)');
  assert.equal(await scoped(`light.classList.add('green');getComputedStyle(light).color`,'assigned light DOM selector'),'rgb(0, 128, 0)');
  assert.equal(await scoped(`ra.querySelector('.item').style.backgroundColor='blue';getComputedStyle(ra.querySelector('.item')).backgroundColor`,
    'internal inline declaration'),'rgb(0, 0, 255)');
  assert.equal(await scoped(`ra.querySelector('.fallback').textContent='Changed fallback';getComputedStyle(a).color`,'hidden fallback text mutation'),'rgb(0, 0, 0)');
  await scoped(`globalThis.label=document.createElement('strong');label.textContent='One';ra.querySelector('.item').appendChild(label);getComputedStyle(label).color`,
    'internal inserted subtree');
  await scoped(`label.firstChild.data='Two';getComputedStyle(label).color`,'internal character data');
  await scoped(`label.firstChild.appendData(' more');label.firstChild.splitText(3);getComputedStyle(label).color`,'character data and sibling insertion');
  await scoped(`label.remove();getComputedStyle(a).color`,'internal removed subtree');

  // Both MutationRecords remain visible when a light node moves across roots.
  assert.deepEqual(await scoped(`b.appendChild(light);[a.contains(light),b.contains(light),getComputedStyle(a).color]`,
    'old and new host on a cross-scope move',2),[false,true,'rgb(0, 0, 0)']);
  await scoped(`a.appendChild(light);getComputedStyle(a).color`,'moving light node back also invalidates both hosts',2);
  await run(`sa.assign(light);getComputedStyle(light).color`);await renderer.screenshot();

  // Document selectors can observe host/light mutations outside either scope.
  await run(`document.querySelector('style').textContent+='section:has(article[title=hot]){background:red}article[title=hot]+article{background:blue}';
    getComputedStyle(outer).backgroundColor`);await renderer.screenshot();
  assert.deepEqual(await scoped(`a.title='hot';[getComputedStyle(outer).backgroundColor,getComputedStyle(b).backgroundColor]`,
    'host attributes still run document has and sibling invalidation'),['rgb(255, 0, 0)','rgb(0, 0, 255)']);

  // A nested root plus light-DOM nested host is always covered by the outer
  // host; partial inner-host metadata must never become the reuse boundary.
  await scoped(`globalThis.nested=document.createElement('article');ra.querySelector('.item').appendChild(nested);
    globalThis.nr=nested.attachShadow({mode:'closed'});nr.innerHTML='<style>span{color:orange}</style><span>Nested</span>';
    getComputedStyle(nr.querySelector('span')).color`,'new nested shadow root');
  assert.equal(await scoped(`nr.querySelector('span').style.color='purple';getComputedStyle(nr.querySelector('span')).color`,
    'nested shadow mutation lifts to outermost host'),'rgb(128, 0, 128)');
  await scoped(`globalThis.lightHost=document.createElement('article');a.appendChild(lightHost);
    globalThis.lr=lightHost.attachShadow({mode:'closed'});lr.innerHTML='<span>Unslotted nested host</span>';
    getComputedStyle(a).color`,'light-DOM nested root retains outermost boundary');
  await scoped(`lr.querySelector('span').textContent='Changed';getComputedStyle(a).color`,'inactive light-DOM nested root mutation');

  await unknown(`a.normalize();a.title='blue';getComputedStyle(a).color`,'unknown before known record');
  await unknown(`a.title='black';a.normalize();getComputedStyle(a).color`,'known record before unknown');
  await unknown(`a.normalize();ra.querySelector('style').textContent+=':host{font-size:18px}';getComputedStyle(a).fontSize`,
    'changed stylesheet cannot cover an unknown marker');
  await unknown(`a.normalize();globalThis.extra=document.createElement('article');ra.querySelector('.item').appendChild(extra);
    extra.attachShadow({mode:'closed'}).innerHTML='<b>Extra</b>';getComputedStyle(a).color`,
    'new scope cannot cover an earlier unknown marker');

  // Manual ownership is not a DOM mutation. Moving a node's ownership to a
  // different root must restore old fallback content, even if the receiving
  // slot is detached and the same batch contains a known stylesheet change.
  await setup();
  assert.equal(await run(`ra.querySelector('.fallback').getBoundingClientRect().height`),0);
  assert.equal(await unknown(`sb.assign(light);rb.querySelector('style').textContent+=':host{font-size:21px}';
    ra.querySelector('.fallback').getBoundingClientRect().height`,'cross-host manual assignment plus known scope update'),17);
  await run(`sa.assign(light);getComputedStyle(a).color`);await renderer.screenshot();
  assert.equal(await unknown(`globalThis.detached=document.createElement('article');globalThis.dr=detached.attachShadow({mode:'closed',slotAssignment:'manual'});
    dr.innerHTML='<slot></slot>';dr.querySelector('slot').assign(light);a.title='blue';
    ra.querySelector('.fallback').getBoundingClientRect().height`,'detached receiving slot invalidates the old connected host'),17);

  // The first scope did not exist when the unknown operation happened.
  await load();
  await unknown(`outer.normalize();globalThis.first=a.attachShadow({mode:'closed'});first.innerHTML='<span>First</span>';
    getComputedStyle(a).color`,'unknown before attaching the first scope');
  assert.deepEqual(errors,[]);
}finally{renderer.dispose();}

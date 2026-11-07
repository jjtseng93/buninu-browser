import {strict as assert} from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

const original=StyleEngine.prototype.compute;
let engine=null,passes=[];
StyleEngine.prototype.compute=function(...args){
  engine??=this;
  const result=original.apply(this,args);
  if(this===engine&&args[5]?.size)passes.push({restyled:this.restyled,requested:args[6]?.reuseUnchangedShadowScopes===true});
  return result;
};
const errors=[];
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error))});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const run=source=>renderer.evaluate(source);
async function update(source,label,mode='scoped'){
  passes=[];
  const result=await run(source);
  await renderer.screenshot();
  assert.deepEqual(errors,[],`${label}: styles agree with a full traversal`);
  if(mode==='scoped')assert.ok(passes.some(pass=>pass.requested&&pass.restyled<60),`${label}: ${JSON.stringify(passes)}`);
  if(mode==='unchanged')assert.ok(passes.every(pass=>pass.restyled<60),`${label}: unused sheet cannot force the full document ${JSON.stringify(passes)}`);
  if(mode==='full')assert.ok(passes.some(pass=>pass.restyled>=120),`${label}: conservative global fallback ${JSON.stringify(passes)}`);
  if(mode==='unknown')assert.ok(passes.some(pass=>!pass.requested&&pass.restyled>=120),`${label}: independent unknown marker ${JSON.stringify(passes)}`);
  return result;
}
try{
  renderer.resize(320,200,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://sheet-provenance.test/',contentType:'text/html',source:`<!doctype html>
    <style>body{margin:0;color:black}article{display:block}#target{color:black}</style>
    <article id="a"><span id="light">Light</span></article><article id="b"></article><div id="target">Document</div>
    <aside>${'<div>Unrelated</div>'.repeat(120)}</aside>`});
  await renderer.whenLoaded();
  await run(`globalThis.a=document.getElementById('a');globalThis.b=document.getElementById('b');globalThis.target=document.getElementById('target');
    globalThis.light=document.getElementById('light');globalThis.ra=a.attachShadow({mode:'closed',slotAssignment:'manual'});
    globalThis.rb=b.attachShadow({mode:'closed',slotAssignment:'manual'});
    ra.innerHTML='<div class="item">A</div><slot><span style="display:block;height:17px">Fallback A</span></slot>';
    rb.innerHTML='<div class="item">B</div><slot></slot>';
    globalThis.sa=ra.querySelector('slot');globalThis.sb=rb.querySelector('slot');sa.assign(light);
    globalThis.colors=()=>[getComputedStyle(ra.querySelector('.item')).color,getComputedStyle(rb.querySelector('.item')).color];colors()`);
  await renderer.screenshot();assert.deepEqual(errors,[]);

  assert.deepEqual(await update(`globalThis.sheet=new CSSStyleSheet();sheet.replaceSync('.item{color:red}');colors()`,
    'unadopted constructed sheet has no visual effect','unchanged'),['rgb(0, 0, 0)','rgb(0, 0, 0)']);
  assert.deepEqual(await update(`ra.adoptedStyleSheets=[sheet];colors()`,'adoption changes one scope'),['rgb(255, 0, 0)','rgb(0, 0, 0)']);
  assert.deepEqual(await update(`rb.adoptedStyleSheets.push(sheet);colors()`,'observable adoption changes the second scope'),['rgb(255, 0, 0)','rgb(255, 0, 0)']);
  assert.deepEqual(await update(`sheet.replaceSync('.item{color:blue}');colors()`,'replaceSync updates every adopting scope'),['rgb(0, 0, 255)','rgb(0, 0, 255)']);
  assert.deepEqual(await update(`sheet.replace('.item{color:blue}').then(()=>colors())`,
    'same-text asynchronous replace preserves the current cascade','unchanged'),['rgb(0, 0, 255)','rgb(0, 0, 255)']);
  assert.deepEqual(await update(`sheet.cssRules[0].style.color='purple';colors()`,'rule.style updates shared sheet text'),['rgb(128, 0, 128)','rgb(128, 0, 128)']);
  assert.deepEqual(await update(`sheet.cssRules[0].selectorText='.absent';colors()`,'selectorText removes old matches'),['rgb(0, 0, 0)','rgb(0, 0, 0)']);
  assert.deepEqual(await update(`sheet.insertRule('.item{color:green}',1);colors()`,'insertRule reparses matching declarations'),['rgb(0, 128, 0)','rgb(0, 128, 0)']);
  assert.deepEqual(await update(`sheet.deleteRule(1);colors()`,'deleteRule removes matching declarations'),['rgb(0, 0, 0)','rgb(0, 0, 0)']);
  await update(`sheet.replaceSync('.item{color:red}');colors()`,'restore the shared source');
  assert.deepEqual(await update(`sheet.disabled=true;colors()`,'disabled constructed sheet leaves both scopes'),['rgb(0, 0, 0)','rgb(0, 0, 0)']);
  assert.deepEqual(await update(`sheet.disabled=false;colors()`,'enabling constructed sheet restores both scopes'),['rgb(255, 0, 0)','rgb(255, 0, 0)']);
  await update(`globalThis.later=new CSSStyleSheet();later.replaceSync('.item{color:blue}');ra.adoptedStyleSheets.push(later);colors()`,
    'new shared-list entry follows existing sheets');
  assert.deepEqual(await update(`ra.adoptedStyleSheets.reverse();colors()`,'adoption reordering preserves cascade order'),['rgb(255, 0, 0)','rgb(255, 0, 0)']);
  assert.deepEqual(await update(`ra.adoptedStyleSheets.pop();colors()`,'observable removal removes the last sheet'),['rgb(0, 0, 255)','rgb(255, 0, 0)']);
  assert.deepEqual(await update(`ra.adoptedStyleSheets=[];colors()`,'removing the remaining adopted sheet restores inherited values'),['rgb(0, 0, 0)','rgb(255, 0, 0)']);

  // Owner-backed stylesheet media and disabled changes also pass through the
  // collectors, without conflating them with arbitrary host state writes.
  assert.equal(await update(`globalThis.style=document.createElement('style');style.textContent='.item{color:green}';ra.prepend(style);
    getComputedStyle(ra.querySelector('.item')).color`,'owned inline stylesheet'), 'rgb(0, 128, 0)');
  assert.equal(await update(`style.sheet.media.mediaText='not all';getComputedStyle(ra.querySelector('.item')).color`,
    'media disables the owned sheet'),'rgb(0, 0, 0)');
  assert.equal(await update(`style.sheet.media.mediaText='all';getComputedStyle(ra.querySelector('.item')).color`,
    'media reenables the owned sheet'),'rgb(0, 128, 0)');
  assert.equal(await update(`style.sheet.disabled=true;getComputedStyle(ra.querySelector('.item')).color`,
    'disabled owned sheet'),'rgb(0, 0, 0)');
  await update(`style.sheet.disabled=false;getComputedStyle(ra.querySelector('.item')).color`,'reenabled owned sheet');

  // Document sheets keep their ordinary global-rule/replacement fallback.
  assert.equal(await update(`globalThis.documentSheet=new CSSStyleSheet();documentSheet.replaceSync('#target{color:blue}');
    document.adoptedStyleSheets=[documentSheet];getComputedStyle(target).color`,'document sheet adoption','any'),'rgb(0, 0, 255)');
  assert.equal(await update(`documentSheet.cssRules[0].style.color='purple';getComputedStyle(target).color`,
    'document rule declaration replacement','full'),'rgb(128, 0, 128)');
  assert.equal(await update(`documentSheet.disabled=true;getComputedStyle(target).color`,'document sheet disabled','full'),'rgb(0, 0, 0)');
  assert.equal(await update(`documentSheet.disabled=false;getComputedStyle(target).color`,'document sheet enabled','any'),'rgb(128, 0, 128)');
  for(const globalRule of ['@property --tone{syntax:"<color>";inherits:false;initial-value:blue}',
    '@keyframes pulse{from{opacity:.2}to{opacity:.8}}','@layer added{#target{background:blue}}']){
    await run(`document.adoptedStyleSheets=[];getComputedStyle(target).color`);await renderer.screenshot();
    assert.equal(await update(`documentSheet.replaceSync(${JSON.stringify(globalRule+'#target{color:green}')});
      document.adoptedStyleSheets=[documentSheet];sheet.cssRules[0].style.fontSize='18px';getComputedStyle(target).color`,
      `global definition remains conservative: ${globalRule}`,'full'),'rgb(0, 128, 0)');
  }

  await update(`a.normalize();sheet.cssRules[0].style.color='purple';colors()`,'unknown before sheet change','unknown');
  await update(`sheet.cssRules[0].style.color='blue';a.normalize();colors()`,'sheet change before unknown','unknown');
  await update(`a.normalize();ra.adoptedStyleSheets=[sheet];colors()`,'new adoption cannot cover unknown state','unknown');
  assert.equal(await update(`sb.assign(light);sheet.cssRules[0].style.color='green';
    ra.querySelector('slot span').getBoundingClientRect().height`,'manual assignment plus sheet change keeps old host fallback','unknown'),17);
  assert.deepEqual(errors,[]);
}finally{renderer.dispose();}

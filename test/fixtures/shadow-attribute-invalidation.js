import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

const original=StyleEngine.prototype.compute;
let rendererEngine=null,full=0;
StyleEngine.prototype.compute=function(...args){
  rendererEngine??=this;
  const result=original.apply(this,args);
  if(this===rendererEngine&&args[5]?.size&&!this.incremental)full++;
  return result;
};
const errors=[];
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error))});
const run=source=>renderer.evaluate(source);
async function incremental(source,label){
  full=0;
  const value=await run(source);
  await renderer.screenshot();
  assert.equal(full,0,label);
  assert.deepEqual(errors,[],`${label}: full-reference style must agree`);
  return value;
}
async function conservative(source,label){
  full=0;
  const value=await run(source);
  await renderer.screenshot();
  assert.ok(full>0,label);
  assert.deepEqual(errors,[],`${label}: full-reference style must agree`);
  return value;
}
try{
  renderer.resize(320,200,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://attribute.test/',contentType:'text/html',source:`<!doctype html>
    <style>body{margin:0}section{color:black}#outer{--first:1px solid red;--second:7px solid blue}</style>
    <section id="outer"><article id="host"><span id="light" slot="main">Light</span></article></section><aside>${'<i></i>'.repeat(80)}</aside>`});
  await renderer.whenLoaded();
  await run(`globalThis.outer=document.getElementById('outer');globalThis.host=document.getElementById('host');
    globalThis.root=host.attachShadow({mode:'closed',slotAssignment:'manual'});
    root.innerHTML='<style>:host{display:block}.inner{color:inherit}::slotted(.chosen){color:green}</style><div class="inner"><slot></slot></div>';
    globalThis.slot=root.querySelector('slot');globalThis.light=document.getElementById('light');slot.assign(light);
    globalThis.inner=root.querySelector('.inner');getComputedStyle(inner).color`);
  await renderer.screenshot();
  assert.deepEqual(errors,[]);

  // Every confirmed path must preserve ordinary ancestor self-only checks.
  const mutations=[
    `outer.setAttribute('class','loaded')`,`outer.removeAttribute('class')`,
    `outer.toggleAttribute('data-ready')`,`outer.toggleAttribute('data-ready')`,
    `outer.setAttributeNS('urn:test','x:state','on')`,`outer.removeAttributeNS('urn:test','state')`,
    `outer.className='loaded'`,`outer.classList.add('ready')`,`outer.classList.remove('ready')`,
    `outer.classList.value='restored'`,`outer.id='renamed'`,`outer.id='outer'`,
    `outer.dataset.ready='yes'`,`delete outer.dataset.ready`,
    `outer.setAttribute('class','loaded');outer.getAttributeNode('class').value='ready'`,
    `outer.attributes.setNamedItem(Object.assign(document.createAttribute('data-ready'),{value:'yes'}))`,
    `outer.attributes.removeNamedItem('data-ready')`,
  ];
  for(const mutation of mutations)
    await incremental(`${mutation};getComputedStyle(outer).color`,mutation);
  assert.equal(await incremental(`outer.style.color='blue';getComputedStyle(inner).color`,'inline style still propagates through closed host'),
    'rgb(0, 0, 255)');
  assert.equal(await incremental(`outer.style.removeProperty('color');getComputedStyle(inner).color`,'removing inline style restores inheritance'),
    'rgb(0, 0, 0)');

  // Pending shorthand data can change while cssText is identical. Its explicit
  // style feature must survive the equal-attribute-record shortcut.
  assert.equal(await incremental(`outer.style.cssText='border:var(--first);border-left-width:5px';
    globalThis.before=outer.style.cssText;getComputedStyle(outer).borderTopWidth`,'initial pending border'),'1px');
  assert.deepEqual(await incremental(`outer.style.border='var(--second)';outer.style.borderLeftWidth='5px';
    [outer.style.cssText===before,getComputedStyle(outer).borderTopWidth]`,'same-text pending border remains observable'),[true,'7px']);
  assert.equal(await incremental(`outer.setAttribute('style',outer.style.cssText);getComputedStyle(outer).borderTopWidth`,
    'same-text direct attribute assignment reparses pending shorthand'),'0px');

  // Unknown operations on the very same node must not be erased by the
  // presence of a confirmed attribute record, in either call order.
  await conservative(`outer.normalize();outer.className='known-after-unknown';getComputedStyle(outer).color`,
    'unknown then known mutation remains conservative');
  await conservative(`outer.className='known-before-unknown';outer.normalize();getComputedStyle(outer).color`,
    'known then unknown mutation remains conservative');

  // Actual hosts, internal shadow nodes, assigned light children and manual
  // slot assignment still cross a scoped boundary and require coherent style.
  await conservative(`host.setAttribute('data-active','');getComputedStyle(host).color`,'host attributes remain scoped');
  assert.equal(await conservative(`inner.style.color='purple';getComputedStyle(inner).color`,'shadow internals remain scoped'),'rgb(128, 0, 128)');
  assert.equal(await conservative(`light.classList.add('chosen');getComputedStyle(light).color`,'assigned light children remain scoped'),'rgb(0, 128, 0)');
  await conservative(`slot.assign();outer.className='another-known';getComputedStyle(host).color`,'manual assignment has independent provenance');
  await run(`slot.assign(light);getComputedStyle(host).color`);await renderer.screenshot();

  // A document selector using an ancestor as a non-subject reaches the host:
  // classification produces a subtree root, and StyleEngine's gate stays full.
  await run(`document.querySelector('style').textContent+='.wide article{font-size:27px}';getComputedStyle(host).fontSize`);
  await renderer.screenshot();
  assert.equal(await conservative(`outer.className='wide';getComputedStyle(host).fontSize`,'document descendant selectors retain full fallback'),'27px');

  // Scoped outside-state dependencies cannot be handled by document traits.
  await run(`root.querySelector('style').textContent+=':host-context(.night){color:red}:host([data-active]){background:blue}';
    getComputedStyle(host).color`);await renderer.screenshot();
  assert.equal(await conservative(`outer.className='night';getComputedStyle(host).color`,'host-context observes ancestor classes'),'rgb(255, 0, 0)');
  assert.equal(await conservative(`host.removeAttribute('data-active');getComputedStyle(host).backgroundColor`,'host metadata still reaches scoped selectors'),
    'rgba(0, 0, 0, 0)');

  // CSSOM and document editing state have no ordinary attribute provenance.
  await conservative(`document.styleSheets[0].insertRule('section{opacity:.75}',0);getComputedStyle(outer).opacity`,
    'stylesheet CSSOM writes retain their own invalidation');
  await conservative(`document.designMode='on';getComputedStyle(host).color`,'designMode remains an unknown document-state change');
  assert.deepEqual(errors,[]);
}finally{
  StyleEngine.prototype.compute=original;
  renderer.dispose();
}

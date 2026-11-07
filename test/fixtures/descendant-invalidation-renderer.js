import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

const original=StyleEngine.prototype.compute;
let engine=null, document=null, passes=[];
StyleEngine.prototype.compute=function(...args) {
  engine??=this;
  const result=original.apply(this,args);
  if (this===engine) {document=args[0];passes.push({restyled:this.restyled,changed:this.changedStyles,incremental:this.incremental});}
  return result;
};
const errors=[];
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error))});
const run=source=>renderer.evaluate(source);
try {
  renderer.resize(320,240,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://invalidation.test/',contentType:'text/html',source:`<!doctype html><style>
    body{margin:0} .active .match{opacity:.5} .active .match::before{content:"ready"}
    [data-open] .attr-target{color:blue} [style] .style-target{opacity:.4}
    .active + section .sibling-target{color:red} .active x-host{color:green}
    main:focus-within .focus-target{color:purple}
    </style><main id="outer"><section id="inner"><button id="target" class="match">target</button>
    <i class="attr-target">attribute</i><i class="style-target">style</i><input><i class="focus-target">focus</i>
    <x-host><span slot="main">slotted</span></x-host></section>${'<span>unrelated</span>'.repeat(150)}</main>
    <section><b class="sibling-target">sibling</b></section>`});
  await renderer.whenLoaded();
  await run(`globalThis.outer=document.getElementById('outer');globalThis.inner=document.getElementById('inner');globalThis.target=document.getElementById('target')`);
  passes=[];
  assert.equal(await run(`outer.className='active';getComputedStyle(target).opacity`),'0.5');
  assert.ok(passes.some(pass=>pass.restyled>0));
  assert.ok(passes.every(pass=>pass.restyled<15),'unrelated ordinary descendants must not recascade');
  assert.equal(await run(`getComputedStyle(document.querySelector('.sibling-target')).color`),'rgb(255, 0, 0)');
  assert.equal(engine.getPseudo(document.getElementById('target'),'before').content,'ready');
  // Mixed ancestor/descendant changes and repeated CSSOM writes are batched.
  assert.equal(await run(`outer.removeAttribute('class');inner.setAttribute('data-open','yes');for(let n=0;n<20;n++)inner.style.width=(200+n)+'px';getComputedStyle(document.querySelector('.attr-target')).color`),'rgb(0, 0, 255)');
  assert.equal(await run(`getComputedStyle(document.querySelector('.style-target')).opacity`),'0.4');
  assert.equal(await run(`getComputedStyle(target).opacity`),'1');
  assert.equal(await run(`getComputedStyle(document.querySelector('.sibling-target')).color`),'rgb(0, 0, 0)');
  await renderer.screenshot();
  // State-dependent invalidation remains conservative and visible.
  assert.equal(await run(`document.querySelector('input').focus();getComputedStyle(document.querySelector('.focus-target')).color`),'rgb(128, 0, 128)');
  await run(`document.querySelector('input').blur();globalThis.host=document.querySelector('x-host');globalThis.shadow=host.attachShadow({mode:'closed'});shadow.innerHTML='<style>:host{display:block}b{color:inherit}</style><b>shadow</b><slot name="main"></slot>'`);
  await renderer.screenshot();
  // A keyed subject can be a host. The style engine owns composed inheritance
  // and must retain its full/scoped fallback rather than skipping shadow DOM.
  assert.equal(await run(`outer.className='active';getComputedStyle(shadow.querySelector('b')).color`),'rgb(0, 128, 0)');
  await renderer.screenshot();
  assert.equal(await run(`outer.className='';getComputedStyle(shadow.querySelector('b')).color`),'rgb(0, 0, 0)');
  await renderer.screenshot();
  assert.deepEqual(errors,[]);
  process.stdout.write('targeted descendant rendering passed\n');
} finally {
  renderer.dispose();StyleEngine.prototype.compute=original;
}

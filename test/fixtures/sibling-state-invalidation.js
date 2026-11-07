import {strict as assert} from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

await loadGraphics();
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});

const original=StyleEngine.prototype.compute;
let engine=null, passes=[];
StyleEngine.prototype.compute=function(...args) {
  engine??=this;
  const result=original.apply(this,args);
  if(this===engine) passes.push(this.restyled);
  return result;
};
const errors=[];
let renderer=null;
const run=source=>renderer.evaluate(source);
const red='rgb(255, 0, 0)', black='rgb(0, 0, 0)';
const read="getComputedStyle(reviewTarget).color";
const body='<main><input><div id="left" class="a">left</div><div id="right" class="b"><span id="target" class="target">target</span></div></main>';
async function load(selector,markup=body) {
  renderer?.dispose();engine=null;
  renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error))});
  renderer.resize(320,240,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://sibling-state.test/',contentType:'text/html',source:`<!doctype html><style>${selector}{color:red}</style>${markup}`});
  await renderer.whenLoaded();
  await run("globalThis.reviewAncestor=document.querySelector('main');globalThis.reviewLeft=document.getElementById('left');globalThis.reviewRight=document.getElementById('right');globalThis.reviewTarget=document.getElementById('target')");
}
try {
  for(const [prefix,on,off] of [
    ['.on',"reviewAncestor.className='on'","reviewAncestor.className=''"],
    ['#on',"reviewAncestor.id='on'","reviewAncestor.id=''"],
    ['[data-on]',"reviewAncestor.setAttribute('data-on','')","reviewAncestor.removeAttribute('data-on')"],
    ['[style]',"reviewAncestor.style.opacity='.9'","reviewAncestor.removeAttribute('style')"],
    ['main:focus-within',"reviewAncestor.querySelector('input').focus()","reviewAncestor.querySelector('input').blur()"],
  ]) {
    for(const combinator of ['+','~']) {
      await load(`${prefix} .a ${combinator} .b .target`);
      assert.equal(await run(read),black,prefix);
      assert.equal(await run(`${on};${read}`),red,prefix);
      assert.equal(await run(`reviewLeft.className='';${read}`),black,prefix+' left removal after enabling ancestor');
      assert.equal(await run(`reviewLeft.className='a';${read}`),red,prefix+' restoring left');
      assert.equal(await run(`${off};${read}`),black,prefix);
      assert.equal(await run(`reviewLeft.className='';${read}`),black,prefix+' left removal after disabling ancestor');
      assert.equal(await run(`${on};reviewLeft.className='a';${read}`),red,prefix+' same-batch ancestor first');
      assert.equal(await run(`reviewLeft.className='';${off};${read}`),black,prefix+' same-batch ancestor last');
      assert.equal(await run(`reviewLeft.className='a';${on};${read}`),red,prefix+' same-batch sibling first');
      assert.equal(await run(`reviewLeft.className='';${read}`),black,prefix+' after mixed batch');
    }
  }
  // The cached prefix's own class can change independently of its left sibling.
  await load('.a + .b .target',body.replace('class="b"','class=""'));
  assert.equal(await run(`reviewRight.className='b';${read}`),red);
  assert.equal(await run(`reviewLeft.className='';${read}`),black);
  // Ancestor :has(), structural state and an outer sibling relation also
  // invalidate a cached inner prefix without a direct attribute mutation.
  for(const [selector,markup,on] of [
    ['main:has(.flag) .a + .b .target',body,"reviewAncestor.querySelector('input').className='flag'"],
    ['main:first-child .a + .b .target','<aside></aside>'+body,"document.querySelector('aside').remove()"],
    ['.on + main .a + .b .target','<aside></aside>'+body,"document.querySelector('aside').className='on'"],
  ]) {
    await load(selector,markup);
    assert.equal(await run(`${on};${read}`),red,selector);
    assert.equal(await run(`reviewLeft.className='';${read}`),black,selector);
  }
  await load('.on .a + .b .target','<main><svg><g id="left" class="a"></g><g id="right" class="b"><text id="target" class="target">target</text></g></svg></main>');
  assert.equal(await run(`reviewAncestor.className='on';${read}`),red);
  assert.equal(await run(`reviewLeft.setAttribute('class','');${read}`),black);
  // Reparenting and added stylesheets must not make revision bookkeeping
  // outlive a fresh cache or forget a cached prefix retained across sheets.
  await load('.on .a + .b .target');
  assert.equal(await run(`reviewAncestor.className='on';${read}`),red);
  assert.equal(await run(`const style=document.createElement('style');style.textContent='.extra .a + .b .target{opacity:.5}';document.head.append(style);${read}`),red);
  assert.equal(await run(`reviewLeft.className='';${read}`),black);
  assert.equal(await run(`reviewLeft.className='a';reviewAncestor.removeChild(reviewRight);reviewAncestor.appendChild(reviewRight);${read}`),red);
  assert.equal(await run(`reviewLeft.className='';${read}`),black);
  // Ordinary unrelated style/attribute writes must not turn every following
  // sibling into a subtree restyle when the cached match stayed false.
  await load('.on .a + .b .target',body.replace('</span>','</span>'+ '<i>unrelated</i>'.repeat(200)));
  await run(`reviewAncestor.style.opacity='.9';reviewAncestor.title='unrelated';${read}`);
  passes=[];
  assert.equal(await run(`reviewLeft.className='';${read}`),black);
  assert.ok(passes.every(count=>count<10),'unrelated ancestor features must preserve narrow sibling invalidation');
  await run(`reviewAncestor.className='on';reviewLeft.className='a';${read}`);
  await run(`reviewAncestor.className='';${read}`);
  assert.equal(await run(`reviewLeft.className='';${read}`),black);
  passes=[];
  assert.equal(await run(`reviewLeft.className='a';${read}`),black);
  assert.ok(passes.every(count=>count<10),'one stale comparison must not permanently invalidate a sibling subtree');
  assert.deepEqual(errors,[]);
  process.stdout.write('sibling state invalidation passed\n');
} finally {
  renderer?.dispose();StyleEngine.prototype.compute=original;
}

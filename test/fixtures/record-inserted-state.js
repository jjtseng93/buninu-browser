import {strict as assert} from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';

await loadGraphics();
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const errors=[],url='https://inserted-state.test/';
const options={verifyStyle:true,reportError:error=>errors.push(String(error))};
const renderer=await createPageRenderer(options);
const read=`Array.from(document.querySelectorAll('[data-check]'),element=>{
  const style=getComputedStyle(element),rect=element.getBoundingClientRect();
  return [element.id,style.color,style.backgroundColor,style.opacity,rect.x,rect.y,rect.width,rect.height];
})`;
async function compareFresh(label){
  const source='<!doctype html>'+await renderer.evaluate('document.documentElement.outerHTML');
  const actual=await renderer.evaluate(read),pixels=await renderer.screenshot();
  const fresh=await createPageRenderer(options);
  try{
    fresh.resize(240,180,1);fresh.setScripting('ses');
    await fresh.loadDocument({url,contentType:'text/html',source});await fresh.whenLoaded();
    const expected=await fresh.evaluate(read);
    assert.equal(JSON.stringify(actual),JSON.stringify(expected),label+': styles and geometry');
    assert.equal(pixels,await fresh.screenshot(),label+': complete fresh-render pixels');
  }finally{fresh.dispose();}
}
try{
  renderer.resize(240,180,1);renderer.setScripting('ses');
  await renderer.loadDocument({url,contentType:'text/html',source:`<!doctype html><style>
    body{margin:0;background:white;color:black} span{display:inline-block;width:40px;height:20px}
    .box:has(.flag) .has{color:red}
    .first:first-child .structural{background:blue}
    .trigger + .branch .sibling{opacity:.4}
  </style><section id="tree"><div class="box"><i id="flag" class="flag"></i>
    <span id="has" class="has" data-check>has</span></div><div><div id="first" class="first">
    <span id="structural" class="structural" data-check>first</span></div></div><div><i id="left" class="trigger"></i>
    <div id="right" class="branch"><span id="sibling" class="sibling" data-check>sib</span>
    </div></div></section><p id="outside" data-check>outside</p>`});
  await renderer.whenLoaded();
  await compareFresh('initial');
  // Flush removal first so the reinserted nodes still have old selector-cache
  // membership, then edit detached descendants without mutation observation.
  await renderer.evaluate(`globalThis.held=document.getElementById('tree');held.remove();document.body.clientWidth`);
  await renderer.evaluate(`held.querySelector('#flag').className='';held.querySelector('#left').className='';held.querySelector('#first').insertAdjacentHTML('beforebegin','<i id=spacer></i>');document.body.prepend(held);document.body.clientWidth`);
  await compareFresh('reinserted after detached mutations');
  // Each match becomes true again. Stale initial membership would miss these
  // transitions even though insertion itself did a full subtree restyle.
  await renderer.evaluate(`document.getElementById('flag').className='flag'`);
  await compareFresh('has state restored');
  await renderer.evaluate(`document.getElementById('spacer').remove();document.getElementById('left').className='trigger'`);
  await compareFresh('structural and sibling prefixes restored');
  await renderer.evaluate(`document.getElementById('left').className=''`);
  await compareFresh('sibling prefix removed');
  // A later insertion must build a new snapshot, not retain the first nodes.
  await renderer.evaluate(`held.remove();document.body.clientWidth`);
  await renderer.evaluate(`document.getElementById('outside').before(held);held.querySelector('#right').append(document.createElement('b'));held.querySelector('#left').className='trigger'`);
  await compareFresh('second reinsertion');
  assert.deepEqual(errors,[]);
  process.stdout.write('inserted state snapshots passed\n');
}finally{renderer.dispose();}

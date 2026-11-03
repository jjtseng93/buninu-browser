import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { RenderTreeBuilder, renderTreeText } from '../../lib/render-tree/index.js';

const renderer = await createPageRenderer({
  fetchResource: async url => ({ok: false, status: 404, url, body: new Uint8Array()}),
});
const original = RenderTreeBuilder.prototype.build;
let builds = 0, latest;
try {
  renderer.resize(400, 300, 1);
  renderer.setScripting('host');
  await renderer.loadDocument({url: 'https://style.test/', contentType: 'text/html', source: `<!doctype html>
    <style>body{margin:0}#box{width:100px;height:50px}#box.wide{width:150px}
      #pseudo::before{content:"before"}#pseudo.changed::before{content:"after"}
      .parent{font-size:25px}.child{font-size:inherit;width:var(--width,20px)}</style>
    <div id=box></div><div id=pseudo></div><div id=parent><span class=child>child</span></div>`});
  await renderer.whenLoaded();
  await renderer.evaluate('document.body.clientWidth');
  RenderTreeBuilder.prototype.build = function (...args) {
    builds++;
    latest = original.apply(this, args);
    return latest;
  };
  await renderer.evaluate(`(() => {
    const box=document.getElementById('box');
    for(let i=0;i<10;i++){
      box.className='unused-'+i;box.style.width='100px';
      if(i%2)getComputedStyle(box).color;
      box.clientWidth;
    }
  })()`);
  assert.equal(builds, 0, 'recomputing equal styles must not rebuild the render tree');
  assert.deepEqual(await renderer.evaluate(`(() => {
    const box=document.getElementById('box');box.className='wide';const a=box.clientWidth;
    box.style.width='175px';getComputedStyle(box).color;const b=box.clientWidth;
    box.style.width='';box.className='';return [a,b,box.clientWidth];
  })()`), [100, 175, 100]);
  // The first inline width still wins over .wide; remove it to test selectors.
  assert.equal(await renderer.evaluate(`(() => {const box=document.getElementById('box');
    box.className='wide';return box.clientWidth;})()`), 150);
  await renderer.evaluate(`document.getElementById('pseudo').className='changed';document.body.clientWidth`);
  assert.ok(renderTreeText(latest).includes('after'), 'pseudo-only style changes must rebuild');
  assert.equal(await renderer.evaluate(`(() => {
    const parent=document.getElementById('parent');parent.className='parent';
    parent.style.setProperty('--width','35px');document.body.clientWidth;
    return getComputedStyle(parent.firstElementChild).fontSize;
  })()`), '25px');
  assert.equal(await renderer.evaluate(`getComputedStyle(document.querySelector('.child')).width`), '35px');
  const beforeCustom = builds;
  assert.equal(await renderer.evaluate(`(() => {
    document.getElementById('parent').style.setProperty('--width','45px');
    const width=getComputedStyle(document.querySelector('.child')).width;
    document.body.clientWidth;return width;
  })()`), '45px');
  assert.ok(builds > beforeCustom, 'a custom property used only by descendants must still invalidate');
  assert.ok(builds > 0, 'actual CSS output must invalidate retained rendering');
  process.stdout.write('style output invalidation passed\n');
} finally {
  RenderTreeBuilder.prototype.build = original;
  renderer.dispose();
}

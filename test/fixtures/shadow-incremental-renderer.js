import {strict as assert} from 'node:assert';
import {createPageRenderer, loadGraphics} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

const errors = [];
const original = StyleEngine.prototype.compute;
let incremental = 0, fullScoped = 0, rendererEngine = null;
StyleEngine.prototype.compute = function (...args) {
  rendererEngine ??= this;
  const result = original.apply(this, args);
  // Verification creates a fresh full-reference engine after incremental
  // passes. Count only the retained engine owned by the renderer.
  if (this === rendererEngine && args[5]?.size) {
    if (this.incremental) incremental++;
    else fullScoped++;
  }
  return result;
};
const renderer = await createPageRenderer({verifyStyle:true, reportError:error=>errors.push(String(error))});
const {CanvasKit:kit} = await loadGraphics();
const evaluate = source => renderer.evaluate(source);
const pixel = async (x,y) => {
  const image = kit.MakeImageFromEncoded(Buffer.from(await renderer.screenshot(), 'base64'));
  try {return [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];}
  finally {image.delete();}
};
try {
  renderer.resize(120,120,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://shadow.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0}#host{display:block;height:40px}#ordinary{height:40px;width:40px;background:red}#ordinary.blue{background:blue}</style><late-host id="host"><span slot="main">L</span><b>UNSLOTTED</b></late-host><main><div id="ordinary"></div></main>'});
  await renderer.whenLoaded();
  await evaluate(`globalThis.host=document.getElementById('host');globalThis.root=host.attachShadow({mode:'closed'});root.innerHTML='<style>:host{color:purple}.box{height:40px;width:40px;background:green}</style><div class="box"><slot name="main"><i>FALLBACK</i></slot></div>'`);
  assert.deepEqual(await pixel(30,10),[0,128,0,255]);
  assert.deepEqual(await pixel(10,50),[255,0,0,255]);
  incremental=0;
  assert.equal(await evaluate(`document.getElementById('ordinary').className='blue';getComputedStyle(document.getElementById('ordinary')).backgroundColor`),'rgb(0, 0, 255)');
  assert.deepEqual(await pixel(10,50),[0,0,255,255]);
  assert.ok(incremental>0,'ordinary updates beside a closed shadow root must use incremental style');
  assert.deepEqual(await pixel(30,10),[0,128,0,255]);
  await evaluate(`root.querySelector('.box').style.backgroundColor='red'`);
  assert.deepEqual(await pixel(30,10),[255,0,0,255]);
  assert.equal(await evaluate(`host.firstElementChild.removeAttribute('slot');root.querySelector('slot').textContent='NEW';getComputedStyle(host).color`),'rgb(128, 0, 128)');
  await renderer.screenshot();
  // Definition changes carry no MutationRecord when no element is upgraded.
  // The scoped invalidation hook must still run; :defined matching itself is
  // not currently implemented by the selector adapter.
  incremental=0;fullScoped=0;
  await evaluate(`customElements.define('unused-definition',class extends HTMLElement{});getComputedStyle(host).color`);
  assert.ok(fullScoped>0,'custom-element definitions invalidate scoped style independently of document traits');
  await evaluate(`root.querySelector('style').textContent+=':host:target{color:blue}'`);
  assert.equal(await evaluate(`getComputedStyle(host).color`),'rgb(128, 0, 128)');
  fullScoped=0;
  await renderer.showFragment('https://shadow.test/');
  assert.equal(fullScoped,0,'unchanged empty fragment must not invalidate scoped style');
  await renderer.showFragment('https://shadow.test/#host');
  assert.equal(await evaluate(`getComputedStyle(host).color`),'rgb(0, 0, 255)');
  assert.deepEqual(errors,[],'verification compares ordinary, closed-shadow, and non-rendered light DOM correctly');
  process.stdout.write('shadow incremental rendering passed\n');
} finally {
  StyleEngine.prototype.compute=original;
  renderer.dispose();
}

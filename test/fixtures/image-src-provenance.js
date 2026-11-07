import {isDeepStrictEqual} from 'node:util';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';

// Node's AssertionError writes Error.stackTraceLimit, which SES locks down.
// Keep failure diagnostics readable without weakening the page compartment.
const fail=(message,actual,expected)=>{throw new Error(`${message}: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);};
const assert={
  equal(actual,expected,message='equal'){if(!Object.is(actual,expected))fail(message,actual,expected);},
  deepEqual(actual,expected,message='deepEqual'){if(!isDeepStrictEqual(actual,expected))fail(message,actual,expected);},
  ok(actual,message='ok'){if(!actual)fail(message,actual,true);},
};

const original=StyleEngine.prototype.compute;
let engine=null,passes=[],pixel=null;
StyleEngine.prototype.compute=function(...args){
  engine??=this;
  const result=original.apply(this,args);
  if(this===engine&&args[5]?.size)passes.push({restyled:this.restyled,requested:args[6]?.reuseUnchangedShadowScopes===true});
  return result;
};
const response=(url,color,width,height)=>({ok:true,status:200,url,contentType:'image/svg+xml',
  body:new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path fill="${color}" d="M0 0h${width}v${height}H0z"/></svg>`)});
const delayed=Promise.withResolvers(),started=Promise.withResolvers(),errors=[];
const renderer=await createPageRenderer({verifyStyle:true,reportError:error=>errors.push(String(error)),
  fetchResource(url,kind){
    assert.equal(kind,'image');
    if(url.endsWith('/held.svg')){started.resolve();return delayed.promise;}
    return Promise.resolve(url.endsWith('/blue.svg')?response(url,'blue',24,18):response(url,'red',16,12));
  },
  onFrame({tile}){
    if(!tile)return;
    const x=Math.floor((1-tile.x)*tile.scale),y=Math.floor((1-tile.y)*tile.scale);
    if(x>=0&&y>=0&&x<tile.pixelWidth&&y<tile.pixelHeight){const offset=(y*tile.pixelWidth+x)*4;pixel=[...tile.pixels.subarray(offset,offset+4)];}
  },
});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const run=source=>renderer.evaluate(source);
async function change(source,label,scoped=false){
  passes=[];
  const result=await run(source);
  await renderer.screenshot();
  assert.deepEqual(errors,[],`${label}: full-reference style comparison`);
  assert.ok(passes.every(pass=>pass.restyled<60),`${label}: unrelated shadow and ordinary styles retained ${JSON.stringify(passes)}`);
  if(scoped)assert.ok(passes.some(pass=>pass.requested),`${label}: complete owning scope is refreshed`);
  return result;
}
const dimensions=`[picture.complete,picture.naturalWidth,picture.naturalHeight,picture.getBoundingClientRect().width,picture.getBoundingClientRect().height]`;
try{
  renderer.resize(320,240,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://image-provenance.test/',contentType:'text/html',source:`<!doctype html>
    <style>body{margin:0;color:black}img{display:block}main:has(img[src$="blue.svg"]){background:yellow}
    img[src$="blue.svg"]+b{color:blue}#picture[src$="blue.svg"]{opacity:.8}</style>
    <main><img id="picture" src="/red.svg"><b id="label">Label</b></main><article id="host"><img id="slotted"></article>
    <aside>${'<div>Unrelated</div>'.repeat(120)}</aside>`});
  await renderer.whenLoaded();
  await run(`globalThis.picture=document.getElementById('picture');globalThis.label=document.getElementById('label');
    globalThis.host=document.getElementById('host');globalThis.slotted=document.getElementById('slotted');
    globalThis.root=host.attachShadow({mode:'closed'});
    root.innerHTML='<style>::slotted(img[src$="blue.svg"]){color:blue}img[src$="blue.svg"]{color:blue}</style><slot></slot><img id="inner">';
    globalThis.inner=root.querySelector('img');getComputedStyle(host).color`);
  await renderer.screenshot();assert.deepEqual(errors,[]);
  assert.deepEqual(await run(dimensions),[true,16,12,16,12]);
  assert.deepEqual(pixel,[255,0,0,255],'initial decoded image is presented');

  assert.deepEqual(await change(`picture.src='/blue.svg';getComputedStyle(picture).opacity;
    picture.decode().then(()=>${dimensions})`,'connected image source updates intrinsic dimensions'),[true,24,18,24,18]);
  assert.deepEqual(await run(`[getComputedStyle(label).color,getComputedStyle(picture.parentElement).backgroundColor,getComputedStyle(picture).opacity]`),
    ['rgb(0, 0, 255)','rgb(255, 255, 0)','0.8'],'attribute, sibling and has selectors all update');
  assert.ok(pixel[2]>=203&&pixel[0]<=52&&pixel[1]<=52,'new blue pixels replace the old red resource');

  await change(`picture.style.cssText='width:30px;height:20px';picture.src='/red.svg';
    picture.decode().then(()=>getComputedStyle(picture).width)`,'fixed CSS dimensions keep their existing resource path');
  assert.deepEqual(await run(dimensions),[true,16,12,30,20]);
  assert.deepEqual(pixel,[255,0,0,255],'fixed-size decoded resource still repaints');

  assert.equal(await change(`slotted.src='/blue.svg';getComputedStyle(slotted).color`,
    'slotted image source changes its owning scope',true),'rgb(0, 0, 255)');
  await run(`slotted.decode()`);await renderer.screenshot();
  assert.equal(await run(`slotted.naturalWidth`),24);
  assert.equal(await change(`inner.src='/blue.svg';getComputedStyle(inner).color`,
    'internal image source changes its owning scope',true),'rgb(0, 0, 255)');
  await run(`inner.decode()`);await renderer.screenshot();
  assert.equal(await run(`inner.naturalWidth`),24);
  assert.deepEqual(await change(`globalThis.detached=new Image();detached.src='/red.svg';
    detached.decode().then(()=>[detached.complete,detached.naturalWidth,detached.naturalHeight])`,'detached image still loads and decodes'),[true,16,12]);

  // Source replacement must reject the pending decode, and late bytes must
  // never replace the newer resource or publish the old intrinsic dimensions.
  await run(`picture.src='/held.svg';globalThis.heldResult=picture.decode().then(()=>'resolved',error=>error.name);true`);
  await started.promise;
  assert.equal(await change(`picture.src='/blue.svg';heldResult`,'source replacement rejects the old decode'),'EncodingError');
  await run(`picture.decode()`);await renderer.screenshot();
  delayed.resolve(response('https://image-provenance.test/held.svg','red',99,77));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(await run(dimensions),[true,24,18,30,20]);

  passes=[];
  await run(`host.normalize();picture.src='/red.svg';getComputedStyle(picture).opacity`);
  await renderer.screenshot();
  assert.ok(passes.some(pass=>!pass.requested&&pass.restyled>=120),'a known image attribute cannot cover an independent unknown host mutation');
  assert.deepEqual(errors,[]);
}finally{
  delayed.resolve(response('https://image-provenance.test/held.svg','red',99,77));
  renderer.dispose();
}

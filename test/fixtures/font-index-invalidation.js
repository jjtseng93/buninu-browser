// Isolate renderer globals and count repeated font-index installation.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {strict as assert} from 'node:assert';
const root=resolve(import.meta.dir,'../..'),mode=process.argv[2]??'layout';
const {createPageRenderer}=await import(pathToFileURL(resolve(root,'lib/renderer/page-renderer.js')));
const {StyleEngine}=await import(pathToFileURL(resolve(root,'lib/style/computed-style.js')));
const {DocumentFonts}=await import(pathToFileURL(resolve(root,'lib/renderer/font-loading.js')));
const mono=await Bun.file(resolve(root,'usr/share/fonts/DejaVuSansMono.ttf')).bytes();
const sans=await Bun.file(resolve(root,'usr/share/fonts/Roboto-Regular.ttf')).bytes();
const original=StyleEngine.prototype.compute,install=DocumentFonts.prototype.setFaces;
let doc,installed=0;
StyleEngine.prototype.compute=function(...args){doc=args[0];return original.apply(this,args)};
DocumentFonts.prototype.setFaces=function(...args){installed++;return install.apply(this,args)};
const requests=[];
const renderer=await createPageRenderer({fetchResource:async url=>({ok:false,status:404,url,body:new Uint8Array()}),
 pageFetch:async({url})=>{requests.push(url);return {status:200,body:url.includes('sans')?sans:mono}}});
const output=[];let viewportWidth=400;
async function snapshot(label){
 renderer.resize(viewportWidth,200,1);await Bun.sleep(0);renderer.resize(viewportWidth,200,1);await Bun.sleep(0);
 const geometry=renderer.inspect('#probe',['width','font-family','font-size']);
 const image=await renderer.screenshot({format:'rgba'});
 output.push({label,geometry,pixels:new Bun.CryptoHasher('sha256').update(image.pixels).digest('hex'),requests:[...requests]});
}
try{
 renderer.resize(400,200,1);
 if(mode==='layout'){
  await renderer.loadDocument({url:'https://font.test/one/',contentType:'text/html',source:`<!doctype html><base href="https://font.test/one/"><style id=faces>@font-face{font-family:Primary;src:url(mono.ttf)}@media(min-width:500px){@font-face{font-family:Primary;src:url(sans.ttf)}}</style><style>body{margin:0}#probe{display:inline-block;font:30px Primary,sans-serif}</style><span id=probe>iiii</span>`});
  await renderer.whenLoaded();await snapshot('initial');
  const base=doc.querySelector('base'),faces=doc.querySelector('#faces'),probe=doc.querySelector('#probe');
  const count=installed;
  for(let i=0;i<3;i++){probe.style.paddingLeft=i+'px';renderer.resize(viewportWidth,200,1)}
  if(DocumentFonts.prototype.updateText)assert.equal(installed,count,'unchanged sheets reuse the installed font index across real layouts');
  await snapshot('style mutations');
  viewportWidth=600;renderer.resize(600,200,1);await snapshot('media on');
  viewportWidth=400;renderer.resize(400,200,1);await snapshot('media off');
  base.href='https://font.test/two/';await snapshot('base URL change');
  const added=doc.createElement('style');added.textContent='@font-face{font-family:Primary;src:url(sans-added.ttf)}';doc.head.appendChild(added);await snapshot('added stylesheet');
  added.remove();await snapshot('removed stylesheet');
  faces.textContent='';await snapshot('remove all faces');
  faces.textContent='@font-face{font-family:Primary;src:url(mono.ttf)}';await snapshot('restore faces');
  await renderer.loadDocument({url:'https://font.test/three/',contentType:'text/html',source:'<style>@font-face{font-family:Primary;src:url(mono.ttf)}#probe{display:inline-block;font:30px Primary,sans-serif}</style><span id=probe>iiii</span>'});
  await renderer.whenLoaded();await snapshot('new document generation');
 }else{
  renderer.setScripting('host');
  await renderer.loadDocument({url:'https://font.test/canvas/',contentType:'text/html',source:`<style id=faces>@font-face{font-family:First;src:url(mono.ttf)}@font-face{font-family:Second;src:url(sans.ttf)}</style><canvas id=c width=300 height=100></canvas><script>window.ctx=document.getElementById('c').getContext('2d')</script>`});
  await renderer.whenLoaded();
  async function draw(font){const width=await renderer.evaluate(`ctx.font=${JSON.stringify(font)};ctx.clearRect(0,0,300,100);ctx.fillText('iiii',4,50);ctx.measureText('iiii').width`);await Bun.sleep(0);const final=await renderer.evaluate(`ctx.clearRect(0,0,300,100);ctx.fillText('iiii',4,50);ctx.measureText('iiii').width`);return final}
  output.push({label:'first',width:await draw('30px First'),requests:[...requests]});
  output.push({label:'second',width:await draw('30px Second'),requests:[...requests]});
  output.push({label:'first again',width:await draw('30px First'),requests:[...requests]});
  await renderer.evaluate(`document.getElementById('faces').textContent='@font-face{font-family:First;src:url(sans.ttf)}'`);
  output.push({label:'face source edited',width:await draw('30px First'),requests:[...requests]});
  const image=await renderer.screenshot({format:'rgba'});
  output.push({label:'canvas final pixels',pixels:new Bun.CryptoHasher('sha256').update(image.pixels).digest('hex')});
 }
 process.stdout.write(JSON.stringify({mode,output,installed})+"\n");
}finally{renderer.dispose();StyleEngine.prototype.compute=original;DocumentFonts.prototype.setFaces=install}

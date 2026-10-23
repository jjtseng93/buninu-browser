// Actual Flea UI + backend, isolated settings, without changing the user's Land.
import {mkdtemp,rm} from 'node:fs/promises';
import {createBrowser} from '/opt/buninu-browser/lib/headless-shell.js';
const dir=await mkdtemp('/tmp/flea-color-ui-');
Object.assign(process.env,{HOME:dir,XDG_CONFIG_HOME:dir+'/config',XDG_CACHE_HOME:dir+'/cache',XDG_DATA_HOME:dir+'/data',XDG_STATE_HOME:dir+'/state',QML_IMPORT_PATH:'/usr/share/omarchy',FLEA_BIN:'/usr/bin/flea',FLEA_PATH:'/root/flea-demo'});
let browser;
try{
 browser=await createBrowser({spareRenderer:false,rendererTimeout:30000});
 await browser.context.resize(900,600);
 await browser.context.addInitScript(`globalThis.codeReaders=[];let rt;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>rt,set:r=>{rt=r;const d=r.describe;r.describe=(v,t,...a)=>{if(t.includes('CodeLines'))codeReaders.push(v);return d(v,t,...a)}}});`);
 await browser.context.navigate('file:///usr/share/flea/ui/boot/shell.qml');
 async function waitFor(expression){for(let i=0;i<200;i++){if(await browser.context.evaluate(expression))return;await Bun.sleep(50)}throw Error('UI timeout: '+expression);}
 await waitFor(`document.body.innerText.includes('hello.js')`);
 for(const [name,text] of [['sample.jsonl','{"answer":42}\n'],['sample.html','<html><body><h1>Hello</h1></body></html>\n']])await Bun.write('/root/flea-demo/'+name,text);
 for(const name of ['hello.js','sample.jsonl','sample.html']){
 await waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`);
 const point=await browser.context.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-qml-type=Text]')].find(e=>e.textContent===${JSON.stringify(name)}&&e.getBoundingClientRect().width>0);const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
 await browser.context.click(...point);
 await browser.context.press(' ',{code:'Space'});
 if(name.endsWith('.html')){await Bun.sleep(800);await browser.context.press('r',{code:'KeyR'});}
 if(name.endsWith('.html')) await waitFor(`Array.from(document.querySelectorAll('[data-qml-type=Text]')).some(e=>e.textContent.includes('<html>')&&Array.from(e.querySelectorAll('span')).some(s=>s.style.color))`);
 else await waitFor(`codeReaders.some(v=>v.active&&v.path.endsWith(${JSON.stringify(name)})&&v.answer==='styled'&&Object.values(v.held).some(l=>l.some((r,i)=>i%2===0&&r>0)))`);
 await Bun.write('/tmp/flea-js-preview.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 console.log('PASS: official Flea UI preview styled: '+name);
 await browser.context.press('Escape',{code:'Escape'});
 }
}catch(error){await Bun.write('/tmp/flea-html-preview.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));console.error(await browser.context.evaluate(`({text:document.body.innerText,html:Array.from(document.querySelectorAll('[data-qml-type=Text]')).filter(e=>e.textContent.includes('<html>')).map(e=>e.innerHTML),readers:codeReaders.map(v=>({active:v.active,path:v.path,answer:v.answer}))})`));throw error;}finally{browser?.close();await rm(dir,{recursive:true,force:true});}

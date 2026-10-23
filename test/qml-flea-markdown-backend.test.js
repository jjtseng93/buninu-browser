import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';
import {fleaSandbox} from './helpers/flea-sandbox.js';
const flea=process.env.BUNINU_FLEA_ROOT,omarchy=process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea||!omarchy||!process.env.FLEA_BIN)('Flea Markdown preview stacks unequal blocks without overlap after scrolling and resizing',async()=>{
 const sandbox=fleaSandbox(flea,omarchy),oldPath=process.env.FLEA_PATH;let browser;
 try{
  process.env.FLEA_PATH=sandbox.values.HOME;
  const sections=Array.from({length:8},(_,i)=>`## Section ${i}\n\n${'A paragraph with enough words to wrap. '.repeat(i+2)}\n\n\`\`\`\n${'a code line\n'.repeat(i+1)}\`\`\`\n`);
  await Bun.write(join(sandbox.values.HOME,'document.md'),'# Markdown preview\n\n'+sections.join('\n'));
  browser=await createBrowser({spareRenderer:false,rendererTimeout:30000});await browser.context.resize(800,600);
  await browser.context.addInitScript(`globalThis.issues=[];addEventListener('unhandledrejection',e=>issues.push(String(e.reason?.stack||e.reason)));globalThis.views=[];let runtime;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>runtime,set:r=>{runtime=r;const d=r.describe;r.describe=(v,t,...a)=>{if(t.includes('ListView'))views.push(v);return d(v,t,...a)}}});`);
  await browser.context.navigate(Bun.pathToFileURL(join(sandbox.flea,'ui/boot/shell.qml')).href);
  const run=s=>browser.context.evaluate(s);
  async function until(fn){for(let i=0;i<180;i++){if(await fn())return;await Bun.sleep(30);}throw Error('Markdown preview did not settle');}
  await until(async()=>(await run('document.body.innerText')).includes('document.md'));
  await browser.context.press(' ',{code:'Space'});
  const view=`views.find(v=>v.count>0&&Array.from({length:v.count},(_,i)=>v.itemAtIndex(i)).some(c=>c?.block?.type))`;
  await until(async()=>await run(`!!(${view})`));
  const read=()=>run(`(()=>{const v=${view};return Array.from({length:v.count},(_,i)=>v.itemAtIndex(i)).filter(Boolean).map(c=>({i:c.blockIndex,y:c.y,h:c.height})).sort((a,b)=>a.i-b.i)})()`);
  const separated=rows=>rows.length>2&&rows.every((row,i)=>row.h>0&&(!i||row.y>=rows[i-1].y+rows[i-1].h));
  await until(async()=>separated(await read()));expect(separated(await read())).toBe(true);
  await run(`(${view}).contentY=650`);await until(async()=>separated(await read()));
  expect(separated(await read())).toBe(true);
  await browser.context.resize(600,600);await until(async()=>separated(await read()));
  expect(separated(await read())).toBe(true);
  expect(await run('issues')).toEqual([]);
  await Bun.write('/tmp/flea-markdown-layout.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 }finally{browser?.close();if(oldPath===undefined)delete process.env.FLEA_PATH;else process.env.FLEA_PATH=oldPath;sandbox.close();}
},60000);

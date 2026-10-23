import { test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const flea=process.env.BUNINU_FLEA_ROOT, omarchy=process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea||!omarchy||!process.env.FLEA_BIN)('Flea initially shows language-marked files and retains rows after repeated pooling',async()=>{
 const sandbox=fleaSandbox(flea,omarchy), oldPath=process.env.FLEA_PATH;
 let browser;
 try {
  process.env.FLEA_PATH=sandbox.values.HOME;
  mkdirSync(join(sandbox.values.HOME,'Documents'));
  await Bun.write(join(sandbox.values.HOME,'Documents/inside.txt'),'inside');
  await Bun.write(join(sandbox.values.HOME,'hello.md'),'hello');
  await Bun.write(join(sandbox.values.HOME,'second.js'),'second');
  browser=await createBrowser({spareRenderer:false,rendererTimeout:30000});
  await browser.context.resize(800,600);
  await browser.context.addInitScript(`globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));`);
  await browser.context.navigate(Bun.pathToFileURL(join(sandbox.flea,'ui/boot/shell.qml')).href);
  const names=column=>browser.context.evaluate(`Array.from(document.querySelectorAll('[data-qml-type="Text"]')).map(e=>({text:e.textContent,r:e.getBoundingClientRect()})).filter(({text,r})=>/^(cache|config|data|home|imports|state|Documents|inside.txt|hello.md|second.js)$/.test(text)&&r.width>0&&r.y>20&&r.x>=${column===0?200:500}&&r.x<${column===0?500:800}).sort((a,b)=>a.r.y-b.r.y).map(e=>e.text)`);
  async function until(column,wanted){for(let i=0;i<150;i++){const actual=await names(column);if(JSON.stringify(actual)===JSON.stringify(wanted))return;await Bun.sleep(30);}expect(await names(column)).toEqual(wanted);}
  const key=k=>browser.context.press(k,{code:k});
  await until(0,['Documents','hello.md','second.js']);
  await browser.context.press('2',{code:'Digit2',modifiers:2});
  await until(1,['inside.txt']);
  for(let i=0;i<4;i++){
   await key('ArrowRight');await until(0,['inside.txt']);
   await key('ArrowLeft');await until(0,['Documents','hello.md','second.js']);
  }
  await key('ArrowLeft');
  const parent=['cache','config','data','home','imports','state'];
  await until(0,parent);await until(1,['Documents','hello.md','second.js']);
  await key('ArrowUp');await until(1,[]);expect(await names(0)).toEqual(parent);
  await key('ArrowDown');await until(1,['Documents','hello.md','second.js']);expect(await names(0)).toEqual(parent);
  await Bun.write('/tmp/flea-columns-fixed.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
  expect(await browser.context.evaluate('qmlErrors')).toEqual([]);
 }finally{browser?.close();if(oldPath===undefined)delete process.env.FLEA_PATH;else process.env.FLEA_PATH=oldPath;sandbox.close();}
},60000);

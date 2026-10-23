import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { encodeImage } from '../lib/paint/frame.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const root=process.env.BUNINU_FLEA_ROOT,omarchy=process.env.BUNINU_OMARCHY_ROOT,binary=process.env.FLEA_BIN;
test.skipIf(!root||!omarchy||!binary)('official Flea backend opens and switches real text and image previews',async()=>{
 const sandbox=fleaSandbox(root,omarchy),oldPath=process.env.FLEA_PATH;
 let browser;
 try {
  process.env.FLEA_PATH=sandbox.values.HOME;
  await Bun.write(join(sandbox.values.HOME,'first.txt'),'First real Flea preview\nDOM textures preserve the previous frame.\n'+'A long preview line.\n'.repeat(150));
  await Bun.write(join(sandbox.values.HOME,'second.txt'),'Second real Flea preview\nThe official backend loaded this file.\n'+'Another long preview.\n'.repeat(170));
  const rgba=new Uint8Array(320*160*4);
  for(let y=0;y<160;y++)for(let x=0;x<320;x++)rgba.set(x<80?[0,100,255,255]:[255,0,0,255],(y*320+x)*4);
  await Bun.write(join(sandbox.values.HOME,'third.png'),await encodeImage(rgba,320,160));
  browser=await createBrowser({spareRenderer:false,rendererTimeout:20000});
  await browser.context.resize(900,600);
  await browser.context.addInitScript(`globalThis.qmlReaders=[];globalThis.qmlRows=[];let runtime;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>runtime,set:r=>{runtime=r;const describe=r.describe;r.describe=(v,t,...a)=>{if(t.includes('PreviewText'))qmlReaders.push(v);if(t.includes('Row'))qmlRows.push(v);return describe(v,t,...a)}}});globalThis.errors=[];addEventListener('error',e=>errors.push(String(e.error?.stack||e.message)));const old=console.error;console.error=(...a)=>{errors.push(a.map(String).join(' '));old(...a)};`);
  await browser.context.navigate(Bun.pathToFileURL(join(sandbox.flea,'ui/boot/shell.qml')).href);
  const run=code=>browser.context.evaluate(code);
  async function until(fn){for(let i=0;i<120;i++){if(await fn())return;await Bun.sleep(30);}throw Error(await run('document.body.innerText+JSON.stringify(errors)'));}
  await until(async()=>(await run('document.body.innerText')).includes('first.txt'));
  const second=await run(`(()=>{const e=[...document.querySelectorAll('[data-qml-type=Text]')].find(e=>e.textContent==='second.txt'&&e.getBoundingClientRect().width>0);const r=e.getBoundingClientRect();return[r.x+r.width/2,r.y+r.height/2]})()`);
  await browser.context.click(...second);await run('0');
  expect(await run(`qmlRows.some(v=>v.row?.n==='second.txt'&&v.selected)`)).toBe(true);
  const pt=await run(`(()=>{const e=[...document.querySelectorAll('[data-qml-type=Text]')].find(e=>e.textContent==='first.txt'&&e.getBoundingClientRect().width>0);if(!e)throw Error('row missing');const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  await browser.context.click(...pt);
  await browser.context.press(' ',{code:'Space'});
  await until(async()=>(await run('document.body.innerText')).includes('First real Flea preview'));
  await until(async()=>!(await run('document.body.innerText')).includes('reading'));
  await Bun.write('/tmp/flea-real-preview-first.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
  await run(`qmlReaders.find(r=>r.active&&r.list).list.contentY=400`);await run('0');
  expect(await run(`qmlReaders.find(r=>r.active&&r.list).list.contentY`)).toBeGreaterThan(0);
  await browser.context.press('ArrowDown',{code:'ArrowDown'});
  await until(async()=>(await run('document.body.innerText')).includes('Second real Flea preview'));
  await until(async()=>await run(`qmlReaders.some(r=>r.active&&r.path.endsWith('/second.txt')&&r.list&&r.list.contentY===0)`));
  expect(await run(`qmlReaders.find(r=>r.active&&r.path.endsWith('/second.txt')).list.contentY`)).toBe(0);
  await Bun.sleep(100);
  await Bun.write('/tmp/flea-real-preview-second.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
  await browser.context.press('ArrowDown',{code:'ArrowDown'});
  await until(async()=>await run(`[...document.querySelectorAll('img')].some(e=>e.src.endsWith('/third.png')&&e.complete&&e.naturalWidth===320)`));
  await until(async()=>!(await run('document.body.innerText')).includes('reading'));
  const png=Buffer.from(await browser.context.screenshot({format:'png'}),'base64');
  await Bun.write('/tmp/flea-real-preview-image.png',png);
  const {CanvasKit:kit}=await import('../lib/renderer/page-renderer.js').then(m=>m.loadGraphics());
  const image=kit.MakeImageFromEncoded(png);
  try { expect([...image.readPixels(450,300,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})]).toEqual([255,0,0,255]); }
  finally { image.delete(); }
  expect(await run('errors')).toEqual([]);
  await browser.context.press('Escape',{code:'Escape'});
 }finally{browser?.close();if(oldPath===undefined)delete process.env.FLEA_PATH;else process.env.FLEA_PATH=oldPath;sandbox.close();}
},45000);

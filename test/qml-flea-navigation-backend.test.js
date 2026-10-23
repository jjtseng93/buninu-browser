import {test,expect} from 'bun:test';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';
import {fleaSandbox} from './helpers/flea-sandbox.js';
const flea=process.env.BUNINU_FLEA_ROOT,omarchy=process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea||!omarchy||!process.env.FLEA_BIN)('Flea expands tilde and preserves language icons after repeated returns from an empty home directory',async()=>{
 const sandbox=fleaSandbox(flea,omarchy),oldPath=process.env.FLEA_PATH;
 let browser;
 try{
  const listing=join(sandbox.dir,'listing');mkdirSync(listing);
  for(const name of ['alpha','beta','gamma'])mkdirSync(join(listing,name));
  for(const name of ['a.md','b.js','c.json','d.qml','e.css','f.md'])await Bun.write(join(listing,name),'test');
  process.env.FLEA_PATH=listing;
  browser=await createBrowser({spareRenderer:false,rendererTimeout:30000});await browser.context.resize(800,600);
  await browser.context.addInitScript(`globalThis.qmlNodes=[];let runtime;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>runtime,set:r=>{runtime=r;const describe=r.describe;r.describe=(v,t,...a)=>{qmlNodes.push({v,t});return describe(v,t,...a)}}});`);
  await browser.context.navigate(Bun.pathToFileURL(join(sandbox.flea,'ui/boot/shell.qml')).href);
  const run=s=>browser.context.evaluate(s),pane=`qmlNodes.find(n=>n.t.includes('Pane')).v`;
  const state=()=>run(`(()=>{const p=${pane};return {path:p.path,state:p.listingState,busy:p.listInFlight}})()`);
  async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await Bun.sleep(30);}throw Error(JSON.stringify(await state()));}
  const icons=()=>run(`qmlNodes.filter(n=>n.t.includes('Row')).map(({v})=>({name:v.row?.n,slug:v.langSlug,live:v.live,item:!!v.langLoader?.item})).filter(v=>v.live&&v.slug)`);
  await until(async()=>(await state()).state==='ready');
  for(let attempt=0;attempt<3;attempt++){
   await browser.context.press('l',{code:'KeyL',modifiers:2});
   await browser.context.press('~',{code:'Backquote',modifiers:8});
   await browser.context.press('Enter',{code:'Enter'});
   await until(async()=>{const s=await state();return s.path===sandbox.values.HOME&&!s.busy&&s.state==='empty'});
   expect((await state()).state).toBe('empty');
   await run(`${pane}.goBack()`);
   await until(async()=>{const s=await state();return s.path===listing&&s.state==='ready'&&!s.busy});
   await until(async()=>{const rows=await icons();return rows.length===6&&rows.every(v=>v.item)});
   expect((await icons()).map(v=>v.name).sort()).toEqual(['a.md','b.js','c.json','d.qml','e.css','f.md']);
  }
 }finally{browser?.close();if(oldPath===undefined)delete process.env.FLEA_PATH;else process.env.FLEA_PATH=oldPath;sandbox.close();}
},60000);

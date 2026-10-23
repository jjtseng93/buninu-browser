// Run from the browser checkout: bun test/manual-without-qml.js
// Retains an isolated copy, logs and screenshots for review. No dependencies installed.
import {cpSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const original=resolve(import.meta.dir,'..');
const dir=mkdtempSync(join(tmpdir(),'browser-without-qml-'));
const copy=join(dir,'buninu-browser');
cpSync(original,copy,{recursive:true,filter:path=>!['.git','node_modules'].includes(relative(original,path).split('/')[0])});
let blocks=0,changed=0;
function strip(dir){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  if(entry.isDirectory()){strip(path);continue;}
  if(!entry.isFile()||!entry.name.endsWith('.js'))continue;
  const source=readFileSync(path,'utf8');let depth=0,count=0;const lines=[];
  for(const line of source.split('\n')){
   if(/^\s*\/\/ qml handle begin\b/.test(line)){depth++;count++;continue;}
   if(/^\s*\/\/ qml handle end\b/.test(line)){if(--depth<0)throw Error('Unmatched end: '+path);continue;}
   if(!depth)lines.push(line);
  }
  if(depth)throw Error('Unclosed handle: '+path);
  if(count){writeFileSync(path,lines.join('\n'));blocks+=count;changed++;}
 }
}
strip(copy);
rmSync(join(copy,'lib/qml'),{recursive:true});
if(existsSync(join(copy,'lib/qml')))throw Error('QML directory still exists');
// Only the test compositor is external; every browser module comes from the copy.
symlinkSync(resolve(original,'../buninu-land'),join(dir,'buninu-land'),'dir');
console.log(JSON.stringify({dir,copy,removedBlocks:blocks,changedFiles:changed,qmlDirectoryRemoved:true}));
async function command(args,cwd,log){
 const out=Bun.file(join(dir,log));
 const p=Bun.spawn([process.execPath,...args],{cwd,env:{...process.env,BUNINU_TEST_WAYLAND:'1'},stdout:out,stderr:out});
 const code=await p.exited;console.log(log,code);if(code!==0)throw Error('Failed: '+log);
}
await command(['test','test/text-input.test.js','test/text-input-pointer.test.js','test/text-input-scroll.test.js','test/clipboard.test.js','test/html-clipboard-wayland.test.js','test/wayland-urlbar.test.js','test/wayland-frontend.test.js'],copy,'tests.log');
// Deterministic rendered fixture: compare full PNG bytes with and without QML.
const fixture=`<!doctype html><meta charset="utf-8"><title>HTML rendering without QML</title><style>body{margin:24px;background:#eef4f7;color:#183440;font:18px sans-serif}input,textarea{display:block;box-sizing:border-box;width:440px;margin:12px 0;padding:8px;border:1px solid #65899b;font:18px monospace}textarea{height:140px}canvas{border:1px solid #65899b}</style><h1>一般網頁 · HTML</h1><p>中文排版、選取、游標與 Canvas</p><input id="field" value="abc 中文 😀 xyz"><textarea>第一行：Hello\n第二行：選取與貼上\n第三行：12345</textarea><canvas id="picture" width="220" height="70"></canvas><script>const c=document.getElementById('picture').getContext('2d');c.fillStyle='#19a7a0';c.fillRect(0,0,220,70);c.fillStyle='white';c.font='20px sans-serif';c.fillText('Canvas 正常',12,42);const f=document.getElementById('field');f.focus();f.setSelectionRange(4,6);</script>`;
const fixturePath=join(dir,'fixture.html');writeFileSync(fixturePath,fixture);
await command(['index.js','--headless','--window-size=640,480','--screenshot='+join(dir,'original.png'),Bun.pathToFileURL(fixturePath).href],original,'original-render.log');
await command(['index.js','--headless','--window-size=640,480','--screenshot='+join(dir,'without-qml.png'),Bun.pathToFileURL(fixturePath).href],copy,'without-qml-render.log');
const before=readFileSync(join(dir,'original.png')),after=readFileSync(join(dir,'without-qml.png'));
if(!before.equals(after))throw Error('Rendering differs: compare screenshots in '+dir);
console.log('PASS: HTML tests and byte-identical rendered PNG; artifacts retained at '+dir);

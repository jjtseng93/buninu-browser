// Finite native-runtime benchmark; no compositor or external application needed.
// bun test/bench-qml-listview.mjs --background=300
// Compare a saved (ordinary file copy, never hardlink) lib/qml/runtime.js with:
// bun test/bench-qml-listview.mjs --background=300 --runtime-before=/tmp/runtime.js
// Repeat in both orders. Timings include the renderer RPC and reactive flush;
// they are not frame-rate measurements. No wall-clock threshold is a test gate.
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RendererHost} from '../lib/renderer/host.js';
const option=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const background=Number(option('background','300'));
if(!Number.isInteger(background)||background<0||background>1000)throw Error('background must be an integer from 0 through 1000');
const before=option('runtime-before','');
const repo=realpathSync(resolve(import.meta.dir,'..'));
const dir=mkdtempSync(join(tmpdir(),'qml-list-bench-'));
const entry=join(dir,'renderer.mjs');
writeFileSync(entry,`
import {plugin} from 'bun';
const before=${JSON.stringify(before?resolve(before):'')};
if(before)plugin({name:'listview-baseline',setup(b){b.onLoad({filter:/\\/qml\\/runtime\\.js$/},async()=>({contents:await Bun.file(before).text(),loader:'js'}))}});
await import(${JSON.stringify(join(repo,'lib/renderer/main.js'))});
`);
const host=new RendererHost({entry,timeout:60000});
try {
 await host.start();await host.call('resize',700,500,1);
 const start=performance.now();
 await host.call('loadDocument',{url:'data:text/x-qml,list-bench',contentType:'text/x-qml',source:`import QtQuick
import Quickshell
FloatingWindow {width:700;height:500
 Repeater {model:${background};delegate:Item {width:1;height:1}}
 ListView {id:list;width:600;height:300;model:1000;clip:true
  delegate:Item {required property int index;width:600;height:60
   Column {Text {text:"row "+index} Text {text:"More text"} Text {text:"Third line"}}
  }
 }
 Component.onCompleted:globalThis.list=list
}`});
 await host.call('whenLoaded');
 const startupMs=performance.now()-start,scrollMs=[];
 for(let i=1;i<=10;i++) {
  const begin=performance.now();
  const found=await host.call('evaluate',`(()=>{list.positionViewAtIndex(${i*6},0);return list.itemAtIndex(${i*6})!==null})()`);
  if(!found)throw Error('Scroll did not instantiate the requested delegate');
  scrollMs.push(performance.now()-begin);
  await Bun.sleep(60);
 }
 const sorted=[...scrollMs].sort((a,b)=>a-b);
 console.log(JSON.stringify({runtimeBefore:before||null,background,startupMs,scrollMs,medianMs:(sorted[4]+sorted[5])/2,bun:Bun.version,platform:process.platform},null,2));
}finally{await host.close();rmSync(dir,{recursive:true,force:true});}

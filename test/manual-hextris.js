#!/usr/bin/env bun
// env NODE_TLS_REJECT_UNAUTHORIZED=0 bun test/manual-hextris.js [buninu|chromium] [output-directory]
// No game patches: Runtime.evaluate observes state; only CDP input operates it.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {launch} from '../tools/browser-lab.js';
const engine=process.argv[2]??'buninu',directory=resolve(process.argv[3]??`/tmp/hextris-validation-${engine}`);
const app=await launch(engine,directory,engine==='chromium'&&process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'?['--ignore-certificate-errors']:[]),c=app.cdp;
const report={engine,url:'https://hextris.io/',states:[]};
const state=()=>c.evaluate('JSON.stringify({state:gameState,position:MainHex.position,blocks:blocks.length,score})').then(JSON.parse);
async function key(key,code,n){for(const type of ['rawKeyDown','keyUp']){await c.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:n});if(type==='rawKeyDown')await Bun.sleep(60);}await Bun.sleep(120);}
try{
 await c.send('Page.navigate',{url:report.url});
 for(let n=0;n<300;n++){if(await c.evaluate('typeof MainHex!=="undefined"&&!!MainHex'))break;await Bun.sleep(100);}
 report.states.push(await state());assert.equal(report.states[0].state,0);
 const point=await c.evaluate('(()=>{const r=document.getElementById("startBtn").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
 for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
 await Bun.sleep(250);assert.equal((await state()).state,1);
 await key('ArrowLeft','ArrowLeft',37);report.states.push(await state());assert.equal(report.states.at(-1).position,1);
 await key('ArrowRight','ArrowRight',39);assert.equal((await state()).position,0);
 await key('p','KeyP',80);assert.equal((await state()).state,-1);
 await Bun.sleep(700);await key('p','KeyP',80);
 for(let n=0;n<50&&(await state()).state!==1;n++)await Bun.sleep(100);
 assert.equal((await state()).state,1);
 let generated=false;
 for(let n=0;n<100;n++){const s=await state();if(s.blocks>0){generated=true;report.states.push(s);break;}await Bun.sleep(100);}
 assert.ok(generated,'live blocks must be generated');
 const {data}=await c.send('Page.captureScreenshot',{format:'png'});await Bun.write(directory+'/playing.png',Buffer.from(data,'base64'));
 report.passed=true;console.log(JSON.stringify(report));
}finally{try{await Bun.write(directory+'/report.json',JSON.stringify(report,null,2));}finally{await app.stop();}}

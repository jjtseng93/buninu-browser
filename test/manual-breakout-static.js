#!/usr/bin/env bun
// Compare the external upstream game and its static-layer patch using real Canvas pixels.
// bun test/manual-breakout-static.js ../Classic-Games [buninu|chromium]
import {resolve} from 'node:path';
import {launch} from '../tools/browser-lab.js';
const root=resolve(process.argv[2]??'../Classic-Games'),engine=process.argv[3]??'buninu';
const result=Bun.spawnSync(['git','-C',root,'show','HEAD:games/breakout/index.html']);
if(result.exitCode)throw Error('Cannot read upstream Breakout');
const original=result.stdout.toString(),cached=await Bun.file(resolve(root,'games/breakout/index.html')).text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){return new Response(new URL(request.url).pathname==='/original'?original:cached,{headers:{'content-type':'text/html'}})}});
let app;
try{
 app=await launch(engine,`/tmp/breakout-static-${engine}`);const c=app.cdp;
 await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{Math.random=()=>.5;let next=0;const frames=new Map();window.requestAnimationFrame=f=>{frames.set(++next,f);return next};window.cancelAnimationFrame=id=>frames.delete(id);window.__step=t=>{const batch=[...frames.values()];frames.clear();for(const f of batch)f(t)};window.__brickPaints=0;const p=CanvasRenderingContext2D.prototype,o=p.roundRect;p.roundRect=function(...a){if(a[2]===52&&a[3]===18)__brickPaints++;return o.apply(this,a)}})()`});
 const snapshots=[];
 for(const name of ['original','cached']){
  await c.send('Page.navigate',{url:`http://127.0.0.1:${server.port}/${name}`});await Bun.sleep(250);
  const point=await c.evaluate(`(()=>{const r=document.getElementById('playBtn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  await c.evaluate('__step(0)');
  const capture=()=>c.evaluate(`document.querySelector('canvas').toDataURL()`);
  const initial=await capture(),paintStart=await c.evaluate('__brickPaints');
  await c.evaluate('__step(16.6666666667)');const idlePaints=await c.evaluate(`__brickPaints-${paintStart}`);
  for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
  await c.evaluate('for(let i=2;i<=110;i++)__step(i*1000/60)');
  const afterHit=await capture(),score=await c.evaluate('document.getElementById("score-val").textContent');
  snapshots.push({name,initial,afterHit,idlePaints,score});
 }
 const [a,b]=snapshots;
 if(a.initial!==b.initial)throw Error('Static cache changes the initial Canvas image');
 if(a.afterHit!==b.afterHit)throw Error('Static cache changes Canvas pixels after a brick hit');
 if(!/\d/.test(b.score)||parseInt(b.score)<=0)throw Error('No brick was destroyed');
 if(a.idlePaints!==60||b.idlePaints!==0)throw Error('Static bricks were not reused');
 console.log(JSON.stringify({engine,passed:true,identicalInitialPixels:true,identicalPixelsAfterHit:true,originalIdleBrickPaints:a.idlePaints,cachedIdleBrickPaints:b.idlePaints,score:b.score}));
}finally{try{await app?.stop()}finally{server.stop(true)}}

#!/usr/bin/env bun
// Controlled RAF timestamps exercise the external game, never browser production code.
// bun test/manual-breakout-paddle.js ../Classic-Games [buninu|chromium]
import {resolve,sep} from 'node:path';
import {launch} from '../tools/browser-lab.js';
const root=resolve(process.argv[2]??'../Classic-Games'),engine=process.argv[3]??'buninu';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
 const path=resolve(root,'.'+new URL(request.url).pathname);
 return path.startsWith(root+sep)?new Response(Bun.file(path)):new Response('Forbidden',{status:403});
}});
let app;
try{
 app=await launch(engine,`/tmp/breakout-paddle-${engine}`);const c=app.cdp;
 await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
 let next=0;const frames=new Map();
 window.requestAnimationFrame=callback=>{frames.set(++next,callback);return next};
 window.cancelAnimationFrame=id=>frames.delete(id);
 window.__step=time=>{const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(time)};
 const p=CanvasRenderingContext2D.prototype,original=p.roundRect;
 p.roundRect=function(...args){if(args[2]===80&&args[3]===12)window.__paddle=args[0];return original.apply(this,args)};
})()`});
 const results=[];
 for(const fps of [15,60,120]){
  await c.send('Page.navigate',{url:`http://127.0.0.1:${server.port}/games/breakout/index.html?fps=${fps}`});await Bun.sleep(300);
  const point=await c.evaluate(`(()=>{const r=document.querySelector('#playBtn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  await c.evaluate('__step(0)');
  const initial=await c.evaluate('__paddle');
  const target=await c.evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.85,y:r.y+r.height*.8}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...target});
  const count=Math.round(fps*.4);
  const actual=await c.evaluate(`(()=>{for(let i=1;i<=${count};i++)__step(i*1000/${fps});return __paddle})()`);
  const expected=initial+480*.4;
  if(Math.abs(actual-expected)>.01)throw Error(`${fps} FPS paddle ${actual}, expected ${expected}`);
  const left=await c.evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.15,y:r.y+r.height*.8}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...left});
  const before=actual;await c.evaluate('__step(1400)');const after=await c.evaluate('__paddle');
  if(Math.abs((before-after)-48)>.01)throw Error('Resume jump does not honor 100 ms catch-up cap');
  results.push({fps,elapsedMs:400,initial,actual,expected,resumeMovement:before-after});
 }
 console.log(JSON.stringify({engine,passed:true,results}));
}finally{try{await app?.stop()}finally{server.stop(true)}}

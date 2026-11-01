#!/usr/bin/env bun
// Real desktop game, ordinary CDP input only. No patches to game state/physics.
// bun test/manual-t-rex-runner.js [buninu|chromium] [output-directory]
import {resolve} from 'node:path';
import {launch} from '../tools/browser-lab.js';
const engine=process.argv[2]??'buninu',directory=resolve(process.argv[3]??`/tmp/t-rex-${engine}`);
const app=await launch(engine,directory),cdp=app.cdp;
const report={engine,url:'https://wayou.github.io/t-rex-runner/',states:[]};
const state=()=>cdp.evaluate(`JSON.stringify({playing:Runner.instance_.playing,intro:Runner.instance_.playingIntro,crashed:Runner.instance_.crashed,time:Runner.instance_.runningTime,obstacles:Runner.instance_.horizon.obstacles.map(o=>({x:o.xPos,y:o.yPos,width:o.width,type:o.typeConfig.type})),score:Runner.instance_.distanceRan})`).then(JSON.parse);
try{
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url:report.url});
 for(let n=0;n<200;n++){
  if(await cdp.evaluate('typeof Runner!=="undefined"&&!!Runner.instance_?.tRex'))break;
  await Bun.sleep(100);
 }
 const rect=await cdp.evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
 await Bun.sleep(200);report.afterMouse=await state();
 // Upstream desktop game does not start on a mouse click, including Chromium.
 if(report.afterMouse.playing)throw Error('Desktop click unexpectedly started the game');
 await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await Bun.sleep(100);
 await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 let captured=false;
 for(let n=0;n<200;n++){
  await Bun.sleep(100);const s=await state();report.states.push(s);
  if(!captured&&s.obstacles.some(o=>o.x>80&&o.x<500)){
   const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
   await Bun.write(directory+'/cactus.png',Buffer.from(data,'base64'));captured=true;
  }
  if(s.crashed)break;
 }
 report.final=await state();report.exceptions=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown');
 if(!captured||!report.final.crashed||report.final.intro||report.exceptions.length)throw Error('Expected visible moving cactus and a real collision');
 const placement=()=>cdp.evaluate(`JSON.stringify((()=>{const r=Runner.instance_.containerEl.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollY}})())`).then(JSON.parse);
 report.beforeRestart=await placement();
 await Bun.sleep(1000);
 await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await Bun.sleep(100);
 await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await Bun.sleep(500);report.afterRestart=await placement();
 report.restartState=await state();
 if(JSON.stringify(report.beforeRestart)!==JSON.stringify(report.afterRestart)||!report.restartState.playing)throw Error('Restart moved the game or failed to start');
 console.log(JSON.stringify({engine,passed:true,screenshot:directory+'/cactus.png',final:report.final,beforeRestart:report.beforeRestart,afterRestart:report.afterRestart}));
}finally{
 try{await Bun.write(directory+'/report.json',JSON.stringify(report,null,2));}finally{await app.stop();}
}

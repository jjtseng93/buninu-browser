#!/usr/bin/env bun
// Live acceptance test; no game patches or third-party packages.
// bun test/manual-clumsy-bird-three-pipes.js [output-directory] [buninu|chromium]
import {resolve} from 'node:path';
import {launch} from '../tools/browser-lab.js';

const directory=resolve(process.argv[2]??'/tmp/clumsy-bird-three-pipes');
const engine=process.argv[3]??'buninu';
const url='https://ellisonleao.github.io/clumsy-bird/';
const app=await launch(engine,directory),cdp=app.cdp;
const report={engine,url,width:900,height:600,passed:false,attempts:[],exceptions:[]};
// Observation only: all controls use ordinary CDP keyboard events.
const readState=`JSON.stringify({
 play:me.state.isCurrent(me.state.PLAY),menu:me.state.isCurrent(me.state.MENU),
 over:me.state.isCurrent(me.state.GAME_OVER),start:game.data.start,score:game.data.steps,
 y:me.state.current().bird?.pos.y,force:me.state.current().bird?.gravityForce,
 collided:me.state.current().bird?.collided,
 pipes:me.game.world.children.filter(o=>o.type==='pipe'&&o.pos.y>0&&o.pos.x>-90)
   .map(o=>({x:o.pos.x,y:o.pos.y})).sort((a,b)=>a.x-b.x)
})`;
const state=async()=>JSON.parse(await cdp.evaluate(readState));
let held=null;
async function key(key,code,keyCode,hold=80){
 const event={key,code,windowsVirtualKeyCode:keyCode};held=event;
 try{
  await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...event});
  await Bun.sleep(hold);
 }finally{
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...event});held=null;
 }
}
try{
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url});
 let loaded=false;
 for(let n=0;n<240;n++){
  if(await cdp.evaluate('typeof me!=="undefined"&&me.state.isCurrent(me.state.MENU)')){loaded=true;break;}
  await Bun.sleep(200);
 }
 if(!loaded)throw Error('Game menu did not load during the manual test');
 for(let attempt=1;attempt<=16&&!report.passed;attempt++){
  if((await state()).over){await key('Enter','Enter',13);await Bun.sleep(700);}
  await key('Enter','Enter',13);
  const started=performance.now(),record={attempt,states:[]};report.attempts.push(record);
  let lastFlap=0,lastScore=-1;
  while(performance.now()-started<180000){
   const s=await state(),elapsedMs=performance.now()-started;
   record.states.push({elapsedMs,...s});
   if(s.score!==lastScore){console.log(JSON.stringify({attempt,elapsedMs,score:s.score}));lastScore=s.score;}
   // The third scoring marker alone is not enough: its pipe must also have
   // cleared the bird, and play must still be active without a collision.
   if(s.score>=3&&s.pipes[0]?.x>150&&s.start&&!s.collided){
    const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
    const after=await state();
    if(after.start&&!after.collided){
     report.passed=true;report.final=after;report.elapsedMs=elapsedMs;
     report.screenshot=directory+'/three-pipes.png';
     await Bun.write(report.screenshot,Buffer.from(data,'base64'));
     console.log('Passed three pipes:',report.screenshot);
     break;
    }
   }
   if(s.over||s.collided){await Bun.sleep(2200);break;}
   if(s.start&&s.play){
    const pipe=s.pipes[0];
    const target=pipe&&pipe.x<650?Math.max(25,Math.min(430,pipe.y-88)):200;
    const now=performance.now();
    if(s.y>target+8&&now-lastFlap>100){lastFlap=now;await key(' ','Space',32,55);}
   }
   await Bun.sleep(10);
  }
 }
 report.exceptions=cdp.events.filter(event=>event.method==='Runtime.exceptionThrown');
 if(!report.passed)throw Error('CDP pilot did not clear three pipes during this run');
}finally{
 try{await Bun.write(directory+'/three-pipes-report.json',JSON.stringify(report,null,2));}
 finally{
  if(held)await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...held}).catch(()=>{});
  await app.stop();
 }
}

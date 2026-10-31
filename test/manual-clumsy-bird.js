#!/usr/bin/env bun
// Live reference check: no page patches, downloaded source or extra packages.
// bun test/manual-clumsy-bird.js [buninu|chromium] [output-directory]
import {resolve} from 'node:path';
import {launch,snapshot} from '../tools/browser-lab.js';
const engine=process.argv[2]??'buninu',directory=resolve(process.argv[3]??'/tmp/clumsy-bird');
const url='https://ellisonleao.github.io/clumsy-bird/';
const app=await launch(engine,directory);
const report={engine,url};
try{
 const {cdp}=app;
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1,mobile:false});
 console.log('navigate');const started=performance.now();await cdp.send('Page.navigate',{url});
 console.log('waiting for menu');
 const until=async expression=>{
  const deadline=performance.now()+30000;
  while(performance.now()<deadline){
   if(await cdp.evaluate(expression,2000).catch(()=>false))return;
   await Bun.sleep(250);
  }
  throw Error('Timed out waiting for '+expression);
 };
 await until('typeof me==="object" && me.state.isCurrent(me.state.MENU)');
 report.menuMs=performance.now()-started;console.log('menu',report.menuMs);
 await snapshot(cdp,directory,'menu');console.log('menu captured');
 const rect=await cdp.evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
 for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...rect,button:'left',clickCount:1});
 await until('me.state.isCurrent(me.state.PLAY)');
 for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
 for(let n=0;n<30&&!await cdp.evaluate('game.data.start');n++){
  for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
  await Bun.sleep(100);
 }
 if(!await cdp.evaluate('game.data.start'))throw Error('Game did not leave its ready screen');
 report.inputStartedGame=true;
 // Starting is a timed ready-screen transition, not proof that jump input works.
 // Keep keyDown held across a real game update before releasing it.
 const before=await cdp.evaluate('me.state.current().bird.pos.y');
 await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await Bun.sleep(100);
 const after=await cdp.evaluate('me.state.current().bird.pos.y');
 await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 report.flight={before,after};
 if(!(after<before))throw Error('Space did not make the bird fly upward');

 report.images=await cdp.evaluate('["clumsy","pipe","ground","logo"].map(name=>{const image=me.loader.getImage(name);return {name,width:image.width,height:image.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight}})');
 if(report.images.some(image=>!image.width||!image.height))throw Error('Loaded sprite image has no dimensions');
 await snapshot(cdp,directory,'playing');
 report.exceptions=cdp.events.filter(event=>event.method==='Runtime.exceptionThrown');
 await Bun.write(resolve(directory,'clumsy-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await app.stop();}

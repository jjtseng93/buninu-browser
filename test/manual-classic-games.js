#!/usr/bin/env bun
// External, unmodified games. Only CDP input controls them; evaluations observe.
// bun test/manual-classic-games.js /path/to/Classic-Games [buninu|chromium] [output-directory]
import {resolve,join,sep} from 'node:path';
import {launch} from '../tools/browser-lab.js';
import {playClassicGame} from './classic-games-scenarios.js';
const root=resolve(process.argv[2]??'../Classic-Games'),engine=process.argv[3]??'buninu',directory=resolve(process.argv[4]??`/tmp/classic-games-${engine}`);
const allGames=['tetris','snake','2048','flappy','space','ttt','memory','mine','pong','breakout','dino','sudoku','connect4','typing','simon','puzzle15'];
const games=process.env.CLASSIC_GAMES?process.env.CLASSIC_GAMES.split(','):allGames;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
 const path=resolve(root,'.'+decodeURIComponent(new URL(request.url).pathname));
 if(path!==root&&!path.startsWith(root+sep))return new Response('Forbidden',{status:403});
 return new Response(Bun.file(path));
}});
let app;const report={engine,games:[]};
try{
 app=await launch(engine,directory,[]);const c=app.cdp;
 await c.send('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
 const read=()=>c.evaluate(`JSON.stringify({ready:document.readyState,text:document.body.innerText.slice(0,1500),canvases:[...document.querySelectorAll('canvas')].map(e=>({w:e.width,h:e.height})),buttons:[...document.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {id:e.id,text:e.textContent.trim(),x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}})})`,90000).then(JSON.parse);

 const shot=async(name)=>{const {data}=await c.send('Page.captureScreenshot',{format:'png'});await Bun.write(join(directory,name+'.png'),Buffer.from(data,'base64'));};
 for(const game of games){
  const entry={game};report.games.push(entry);const started=performance.now();c.events.length=0;
  const logFile=join(directory,engine+'.log');const logStart=(await Bun.file(logFile).text()).length;
  try{
   await c.send('Page.navigate',{url:`http://127.0.0.1:${server.port}/games/${game}/index.html`});
   await Bun.sleep(1400);entry.initial=await read();await shot(game+'-initial');
   entry.evidence=await playClassicGame(c,game);
   await Bun.sleep(150);entry.after=await read();await shot(game+'-after');
  }catch(error){entry.error=error.stack;}
  entry.exceptions=c.events.filter(e=>e.method==='Runtime.exceptionThrown');
  entry.pageErrors=(await Bun.file(logFile).text()).slice(logStart).split('\n').filter(line=>line.includes('page error:'));
  entry.passed=!entry.error&&!entry.exceptions.length&&!entry.pageErrors.length&&!!entry.evidence?.length;
  entry.ms=performance.now()-started;console.log(JSON.stringify({game,ms:Math.round(entry.ms),passed:entry.passed,error:entry.error,pageErrors:entry.pageErrors,exceptions:entry.exceptions.length,evidence:entry.evidence,buttons:entry.initial?.buttons.map(b=>b.text),text:entry.after?.text.slice(0,180)}));
  await Bun.write(join(directory,'report.json'),JSON.stringify(report,null,2));
 }
 report.passed=report.games.every(game=>game.passed);
 await Bun.write(join(directory,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,total:report.games.length,passedGames:report.games.filter(game=>game.passed).length}));
 if(!report.passed)process.exitCode=1;
}finally{try{await app?.stop();}finally{server.stop(true);}}

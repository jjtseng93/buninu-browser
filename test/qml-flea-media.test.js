import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';
import {fleaSandbox} from './helpers/flea-sandbox.js';
const root=process.env.BUNINU_FLEA_ROOT,omarchy=process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!root||!omarchy)('unchanged Flea PreviewMedia loads MP4 and MP3 through the shared player',async()=>{
 const sandbox=fleaSandbox(root,omarchy);let browser;
 try{
  const video=Bun.pathToFileURL(join(import.meta.dir,'fixtures/long-video.mp4')).href;
  const audio=Bun.pathToFileURL(join(import.meta.dir,'fixtures/tone.mp3')).href;
  const file=join(sandbox.dir,'main.qml');
  await Bun.write(file,`import QtQuick
import ${JSON.stringify(join(root,'ui'))} as Flea
Flea.PreviewMedia {id:preview;width:640;height:360;kind:"video";autoStart:false;path:${JSON.stringify(Bun.fileURLToPath(video))}}`);
  browser=await createBrowser({spareRenderer:false});
  await browser.context.addInitScript(`globalThis.players=[];let rt;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>rt,set:r=>{rt=r;const d=r.describe;r.describe=(v,t,...a)=>{if(t.includes('MediaPlayer'))players.push(v);return d(v,t,...a)}}});`);
  await browser.context.navigate(Bun.pathToFileURL(file).href);
  const run=s=>browser.context.evaluate(s);
  async function until(code){for(let i=0;i<200;i++){if(await run(code))return;await Bun.sleep(30)}throw Error(await run('document.body.innerText'));}
  await until('players[0]?.duration>1000');
  expect(await run('players[0].hasVideo')).toBe(true);
  expect(await run('players[0].error')).toBe(0);
  await Bun.write('/tmp/qml-flea-media-poster.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
  await run(`players[0].source=${JSON.stringify(audio)}`);
  await until('players[0]?.hasAudio&&!players[0].hasVideo&&players[0].duration>500');
  expect(await run('players[0].error')).toBe(0);
 }finally{browser?.close();sandbox.close();}
},30000);

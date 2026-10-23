import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';
import {applyQmlMediaGain} from '../lib/qml/media-renderer.js';
test('QML MP4/MP3 reuse HTML decoding, metadata, pause and millisecond seek',async()=>{
 const dir=mkdtempSync('/tmp/qml-media-');let browser;
 try {
  const video=Bun.pathToFileURL(join(import.meta.dir,'fixtures/long-video.mp4')).href;
  const audio=Bun.pathToFileURL(join(import.meta.dir,'fixtures/tone.mp3')).href;
  await Bun.write(join(dir,'main.qml'),`import QtQuick
import QtMultimedia
import Quickshell.Wayland
Rectangle {width:320;height:240;color:"black"
 AudioOutput {id:out;volume:0;muted:true}
 VideoOutput {id:screen;anchors.fill:parent}
 MediaPlayer {id:player;source:${JSON.stringify(video)};audioOutput:out;videoOutput:screen}
 IdleInhibitor {enabled:true}
 Text {id:status;text:player.mediaStatus+":"+player.duration+":"+player.position+":"+player.error}
 Button {id:play;onClicked:player.play()}
 Button {id:pause;onClicked:player.pause()}
 Button {id:seek;onClicked:player.position=500}
 Button {id:switchAudio;onClicked:player.source=${JSON.stringify(audio)}}
}`);
  browser=await createBrowser({spareRenderer:false});
  await browser.context.addInitScript(`globalThis.mediaNodes=[];let rt;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>rt,set:r=>{rt=r;const d=r.describe;r.describe=(v,t,...a)=>{if(t.includes('MediaPlayer')||t.includes('VideoOutput'))mediaNodes.push({v,t});return d(v,t,...a)}}});`);
  await browser.context.navigate(Bun.pathToFileURL(join(dir,'main.qml')).href);
  const run=s=>browser.context.evaluate(s);

  const status=()=>run("(()=>{const p=mediaNodes.find(n=>n.t.includes('MediaPlayer')).v;return {duration:p.duration,position:p.position,error:p.error,message:p.errorString,state:p.playbackState,ready:p.mediaStatus,hasVideo:p.hasVideo,hasAudio:p.hasAudio}})()");
  async function until(fn){for(let i=0;i<200;i++){const s=await status();if(s.error)throw Error(JSON.stringify(s));if(fn(s))return s;await Bun.sleep(25)}throw Error(JSON.stringify(await status()));}
  expect((await until(s=>s.duration>1000)).hasVideo).toBe(true);
  await run("document.getElementById('play').click()");
  await until(s=>s.state===1&&s.position>100);
  await run("document.getElementById('pause').click()");
  expect((await status()).state).toBe(2);
  await run("document.getElementById('seek').click()");
  await until(s=>Math.abs(s.position-500)<50);
  const png=await browser.context.screenshot({format:'png'});
  await Bun.write('/tmp/qml-media-video.png',Buffer.from(png,'base64'));
  expect(await run("mediaNodes.find(n=>n.t.includes('VideoOutput')).v.contentRect.width")).toBeGreaterThan(0);
  await run("document.getElementById('switchAudio').click()");
  const s=await until(s=>s.hasAudio&&!s.hasVideo&&s.duration>500);
  expect(s.error).toBe(0);
  await run("document.getElementById('seek').click()");
  await until(s=>Math.abs(s.position-500)<50);
 }finally{browser?.close();rmSync(dir,{recursive:true,force:true})}
},30000);

test('QML PCM gain scales the output chunk without requiring a new audio backend',()=>{
 const pcm=Buffer.alloc(6);pcm.writeInt16LE(-2000,0);pcm.writeInt16LE(1000,2);pcm.writeInt16LE(32767,4);
 applyQmlMediaGain(pcm,0.5);
 expect([pcm.readInt16LE(0),pcm.readInt16LE(2),pcm.readInt16LE(4)]).toEqual([-1000,500,16384]);
 applyQmlMediaGain(pcm,0);expect([...pcm]).toEqual([0,0,0,0,0,0]);
});


test('QML MP3 playback sends real PCM, mutes and releases the shared audio output',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/qml-media-audio.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,error}).toEqual({code:0,error:''});
 expect(out).toContain('QML real MP3 PCM playback passed');
},30000);

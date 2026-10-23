// Real Flea media component, decoder and host PulseAudio connection.
import {createBrowser} from '/opt/buninu-browser/lib/headless-shell.js';
import {PulseClient} from '/opt/buninu-browser/lib/audio/pulse-client.js';
import {mkdtemp,rm} from 'node:fs/promises';
const dir=await mkdtemp('/tmp/flea-media-check-');
Object.assign(process.env,{HOME:dir,XDG_CONFIG_HOME:dir+'/config',XDG_CACHE_HOME:dir+'/cache',QML_IMPORT_PATH:'/usr/share/omarchy',FLEA_BIN:'/usr/bin/flea',FLEA_PATH:'/root/flea-demo'});
let b;
try{
 const pulse=await Promise.race([PulseClient.connect(),Bun.sleep(5000).then(()=>{throw Error('Pulse connection timeout')})]);
 console.log('Pulse connected');pulse.close();
 b=await createBrowser({spareRenderer:false});
 await b.context.addInitScript(`globalThis.players=[];globalThis.panes=[];let rt;Object.defineProperty(globalThis,'__qmlRuntime',{get:()=>rt,set:r=>{rt=r;const d=r.describe;r.describe=(v,t,...a)=>{if(t.includes('Pane'))panes.push(v);if(t.includes('MediaPlayer'))players.push(v);return d(v,t,...a)}}});`);
 await b.context.navigate('file:///usr/share/flea/ui/boot/shell.qml');
 await Bun.sleep(1500);
 await b.context.press('2',{code:'Digit2',modifiers:2});
 await Bun.sleep(300);
 const point=await b.context.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-qml-type=Text]')].find(e=>e.textContent==='tone.mp3'&&e.getBoundingClientRect().width>0);const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
 await b.context.click(...point);await Bun.sleep(500);
 console.log('before',await b.context.evaluate(`panes.map(p=>({mode:p.viewMode,path:p.previewColumnItem?.path,visible:p.previewColumnItem?.visible,allowed:p.previewColumnItem?.playerAllowed}))`));
 await b.context.evaluate(`panes[0].previewColumnItem.mediaStripItem().toggled()`);

 for(let i=0;i<8;i++){
  await Bun.sleep(400);
  console.log('column',await b.context.evaluate(`panes.map(p=>({wants:p.previewColumnItem?.wantsPlayback,loaded:p.previewColumnItem?.playerLoaded(),playing:p.previewColumnItem?.mediaPlaying(),position:p.previewColumnItem?.mediaPosition()}))`));
  console.log(await b.context.evaluate(`players.map(p=>({source:p.source,error:p.error,message:p.errorString,position:p.position,duration:p.duration,state:p.playbackState,volume:p.audioOutput?.volume,muted:p.audioOutput?.muted}))`));
 }
}finally{b?.close();await rm(dir,{recursive:true,force:true});}

process.exit(0);

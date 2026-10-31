// Live reference test; opens only its own headless browser and closes it.
// bun test/manual-numbered-music.js [buninu|chromium] [output-directory]
import {launch} from '../tools/browser-lab.js';
import assert from 'node:assert/strict';
const engine=process.argv[2]??'buninu',dir=process.argv[3]??'/tmp/numbered-music-playback-'+Date.now();
const b=await launch(engine,dir,engine==='chromium'?['--autoplay-policy=no-user-gesture-required']:[]),c=b.cdp;
try{
 await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.testContexts=[];window.testFrequencies=[];window.testOscillators=[];const OriginalAudioContext=window.AudioContext;window.AudioContext=class extends OriginalAudioContext{constructor(...a){super(...a);testContexts.push(this);}createOscillator(){const o=super.createOscillator();testOscillators.push(o);const p=o.frequency,set=p.setValueAtTime.bind(p);p.setValueAtTime=(v,t)=>{testFrequencies.push({v,t});return set(v,t)};return o;}};`});
 await c.send('Page.navigate',{url:'https://drjohnjstest.blogspot.com/2023/10/text-to-numbered-musical-notation.html'});
 for(let i=0;i<150;i++){if(await c.evaluate('typeof playsheet==="function"'))break;await Bun.sleep(200);}
 const song='Title=Web Audio test\nSpeed=180\n1234567*1';
 await c.evaluate(`tsheet.value=${JSON.stringify(song)};document.querySelector('button[onclick="playsheet(tsheet.value);"]').click();`);
 for(let i=0;i<100;i++) {
  if(await c.evaluate('testFrequencies.filter(e=>e.v>20).length>=8'))break;
  await Bun.sleep(100);
 }
 await Bun.sleep(400);
 let state=await c.evaluate('({contexts:testContexts.map(c=>({state:c.state,time:c.currentTime})),frequencies:testFrequencies,oscillators:testOscillators.length})');console.log('play button',{contexts:state.contexts,pitches:state.frequencies.filter(e=>e.v>20).map(e=>e.v)});assert.equal(state.oscillators,1);assert.ok(state.contexts[0].time>1);assert.ok(state.frequencies.filter(e=>e.v>20).length>=8);
 await c.evaluate(`Promise.all([playsheet(${JSON.stringify('Speed=240\n1234')}),playsheet2(${JSON.stringify('Speed=240\n567*1')})])`);await Bun.sleep(2400);
 state=await c.evaluate('({contexts:testContexts.map(c=>({state:c.state,time:c.currentTime})),frequencies:testFrequencies,oscillators:testOscillators.length})');console.log('two parts',{contexts:state.contexts,oscillators:state.oscillators});assert.equal(state.oscillators,2);assert.ok(state.contexts.every(c=>c.state==='running'&&c.time>1));
 const exceptions=c.events.filter(e=>e.method==='Runtime.exceptionThrown');assert.deepEqual(exceptions,[]);
 const shot=await c.send('Page.captureScreenshot',{format:'png'});await Bun.write(dir+'/playback.png',Buffer.from(shot.data,'base64'));console.log('screenshot',dir+'/playback.png');
 console.log('PASS: original Play button, changing pitches and two-part playback use running Web Audio outputs');
}finally{await b.stop();}

import '../../vendor/ses/dist/ses.mjs';
// Injected decoder exercises real renderer playback
// lifetime without requiring an audio daemon or decoding a large media file.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const sleep=Bun.sleep, errors=[];let opens=0,closes=0,decoded=0,fetches=0;
const renderer=await createPageRenderer({
  onFrame(){},renderMinInterval:16,
  reportError:error=>errors.push(String(error)),
  fetchResource:async url=>{fetches++;return {ok:true,url,body:new Uint8Array(32),contentType:'video/mp4'}},
  videoDecoder:{probe:async()=>({duration:10,video:{width:8,height:8}}),
    decode:async()=>{opens++;return {width:8,height:8,fps:30,seek(){},close(){closes++},
      nextFrame(width,height){decoded++;const pixels=new Uint8Array(width*height*4);pixels.fill(255);return pixels}}},
  },
});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
try {
  renderer.resize(160,120,1);renderer.setScripting('ses');
  await renderer.loadDocument({url:'https://move.test/',contentType:'text/html',source:`
    <style>@keyframes move{from{opacity:.1}to{opacity:.9}}.animated{animation:move 20s linear both;width:8px;height:8px;background:red}video{width:8px;height:8px}</style>
    <div id=source><video src="clip.mp4" muted></video><div class=animated></div><iframe style="width:10px;height:10px"></iframe></div><section id=dest></section>`});
  await renderer.whenLoaded();
  await renderer.evaluate(`globalThis.source=document.getElementById('source');globalThis.dest=document.getElementById('dest');
    globalThis.v=source.firstChild;globalThis.animated=source.children[1];globalThis.frame=source.lastChild;globalThis.child=frame.contentWindow;
    globalThis.ticks=0;child.setInterval(()=>ticks++,10);globalThis.animationEvents=[];
    animated.addEventListener('animationstart',e=>animationEvents.push(e.type));animated.addEventListener('animationcancel',e=>animationEvents.push(e.type));
    void v.play();`);
  for(let n=0;n<100&&decoded<2;n++)await sleep(10);
  assert.ok(decoded>=2,JSON.stringify({message:'video playback started',decoded,opens,closes,fetches,errors,state:await renderer.evaluate('[v.readyState,v.paused,v.currentTime,v.currentSrc]')}));
  // Longer than the post-move interval: a restarted animation cannot appear
  // to advance merely because we waited longer after moving it.
  await sleep(300);
  const initial=await renderer.evaluate(`[v.currentTime,getComputedStyle(animated).opacity,ticks]`);
  const beforeFrames=decoded,beforeOpens=opens,beforeCloses=closes,beforeFetches=fetches;
  await renderer.evaluate(`globalThis.eventsBefore=animationEvents.slice();dest.moveBefore(source,null);`);
  await sleep(140);
  const after=await renderer.evaluate(`[v.currentTime,getComputedStyle(animated).opacity,ticks,frame.contentWindow===child,v.paused,
    JSON.stringify(animationEvents)===JSON.stringify(eventsBefore)]`);
  assert.ok(after[0]>initial[0],'media timeline advances through move');
  assert.ok(Number(after[1])>Number(initial[1]),'CSS animation continues from its old time');
  assert.ok(after[2]>initial[2],'same iframe timer keeps running');
  assert.deepEqual(after.slice(3),[true,false,true]);
  assert.ok(decoded>beforeFrames,'same decoder continues producing pictures');
  assert.deepEqual([opens,closes,fetches],[beforeOpens,beforeCloses,beforeFetches],'no decoder close/reopen or refetch');
  assert.deepEqual(errors,[]);
  process.stdout.write('Atomic move renderer media/animation/iframe preservation passed\n');
} finally {renderer.dispose();}

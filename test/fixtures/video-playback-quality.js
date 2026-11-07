import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
const sleep = Bun.sleep, errors = [], outputs = [], mse = process.argv[2] === 'mse';
const renderer = await createPageRenderer({
  fetchResource: async () => ({ ok:true, body:new Uint8Array([1]), contentType:'video/mp4' }),
  reportError: error => errors.push(error.stack ?? String(error)),
  videoDecoder: {
    probe: async () => ({duration:10,video:{width:2,height:2},audio:{sampleRate:1000}}),
    decode: async () => {let at=0;return {width:2,height:2,fps:10,
      nextFrame(w,h){return new Uint8Array(w*h*4).fill(++at);},seek(ms){at=Math.floor(ms/1000)*10;},close(){}};},
    decodeAudio: async () => ({sampleRate:1000,channels:1,nextSamples:()=>new Float32Array(100),close(){}}),
  },
  audio: {
    open(options,listener){outputs.push(listener);return outputs.length;}, write(){}, close:async()=>0, finish(){},
  },
});
await import('../../vendor/ses/dist/ses.mjs');
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const quality = () => renderer.evaluate(`JSON.stringify((()=>{const v=document.getElementById('v'),q=v.getVideoPlaybackQuality();return [q.totalVideoFrames,q.droppedVideoFrames,q.corruptedVideoFrames,v.webkitDecodedFrameCount,v.webkitDroppedFrameCount]})())`).then(value => { if (value === undefined) throw Error('quality undefined: '+JSON.stringify(errors)); return JSON.parse(value); });
const waitFor = async predicate => {for(let i=0;i<100;i++){if(await predicate())return;await sleep(10);}assert.fail('media did not progress');};
try {
  renderer.setScripting('ses');renderer.resize(200,100,1);
  await renderer.loadDocument({url:'https://quality.test/',contentType:'text/html',source:`<video id=v ${mse ? '' : 'src="one.mp4"'}></video>`});
  assert.deepEqual(await quality(),[0,0,0,0,0]);
  if (mse) {
    // The mocked decoder ignores this payload; a complete mdat selects the
    // normal MSE pipeline without depending on actual codec bytes.
    await renderer.evaluate(`(() => {
      const source=new MediaSource(),v=document.getElementById('v');
      v.src=URL.createObjectURL(source);source.duration=10;
      const buffer=source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"');
      const bytes=new Uint8Array(1024);new DataView(bytes.buffer).setUint32(0,1024);
      bytes.set([109,100,97,116],4);buffer.appendBuffer(bytes);
    })()`);
  }
  await renderer.evaluate(`document.getElementById('v').play()`);
  await waitFor(()=>outputs.length===1);
  outputs[0]({event:'request',bytes:2000});
  await waitFor(async()=>(await quality())[0]===1);
  await renderer.evaluate(`globalThis.oldQuality=document.getElementById('v').getVideoPlaybackQuality()`);
  outputs[0]({event:'timing',seconds:.5,sentSeconds:1,sinkSeconds:.5});
  await waitFor(async()=>(await quality())[0]===6);
  assert.deepEqual(await quality(),[6,4,0,6,4]);
  assert.equal(await renderer.evaluate('oldQuality.totalVideoFrames'),1,'returned quality is a snapshot');
  await renderer.evaluate(`document.getElementById('v').pause()`);
  const paused=await quality();await sleep(120);assert.deepEqual(await quality(),paused);
  await renderer.evaluate(`document.getElementById('v').currentTime=.2`);
  await waitFor(async()=>(await quality())[0]>paused[0]);
  assert.equal((await quality())[1],4,'a seek is not a dropped-frame burst');
  assert.equal(await renderer.evaluate(`(() => {
    const v=document.getElementById('v');v.load();
    return v.getVideoPlaybackQuality().totalVideoFrames;
  })()`),0,'explicit load resets counts even when it reuses a MediaSource');
  assert.equal(await renderer.evaluate('oldQuality.totalVideoFrames'),1,'reset does not mutate earlier snapshots');
  await renderer.evaluate(`document.getElementById('v').src='two.mp4'`);
  assert.deepEqual(await quality(),[0,0,0,0,0],'new source resets resource counters');
  await renderer.loadDocument({url:'https://quality.test/next',contentType:'text/html',source:'<video id=v></video>'});
  assert.deepEqual(await quality(),[0,0,0,0,0],'navigation resets counters');
  assert.deepEqual(errors,[]);
  process.stdout.write('video playback quality passed\n');
} finally {renderer.dispose();}

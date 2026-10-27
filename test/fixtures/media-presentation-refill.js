// Isolated because host scripting installs browser globals in this process.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createBytePipe} from '../../lib/media/byte-pipe.js';

const sleep = Bun.sleep, pipe = createBytePipe();
pipe.append(new Uint8Array(1024));
const decoders = [], messages = [], errors = [], outputs = [];
let holdNext = false, finishOpen;
const renderer = await createPageRenderer({
  onFrame() {}, onVideo: message => messages.push(message),
  fetchResource: async () => ({ok:true, contentType:'video/mp4', body:pipe}),
  reportError: error => errors.push(String(error)),
  videoDecoder: {
    probe: async () => ({duration:30, video:{width:20,height:12}, audio:{sampleRate:1000}}),
    async decode() {
      const record = {seeks:[], frames:0, at:0};
      const decoder = {width:20,height:12,fps:10,
        seek(ms) {record.seeks.push(ms); record.at=Math.floor(ms/1000);},
        nextFrame(w,h) {record.frames++; const bytes=new Uint8Array(w*h*4).fill(20+Math.floor(record.at));record.at+=0.1;return bytes;},
        close() {},
      };
      decoders.push(record);
      if (holdNext) {holdNext=false; await new Promise(resolve => {finishOpen=resolve;});}
      return decoder;
    },
    decodeAudio: async () => ({sampleRate:1000,channels:1,
      nextSamples:()=>new Float32Array(100), close() {}}),
  },
  audio: {
    open(options, listener) {outputs.push({listener,samples:0});return outputs.length;},
    write(id, bytes) {outputs[id-1].samples+=bytes.length/2;},
    close(id) {return Promise.resolve(outputs[id-1].samples*2);},
    finish() {},
  },
});
const currentPresentation = () => messages.filter(message=>message.type==='video-open').at(-1);
const opens = () => messages.filter(message=>message.type==='video-open').length;
const waitFor = async condition => {
  for (let attempt=0;attempt<200;attempt++) {if(condition())return;await sleep(5);}
  assert.fail(`timed out waiting for media transition: ${condition}; ${JSON.stringify({decoders, messages:messages.map(({type,id})=>({type,id})),errors})}`);
};
const clock = seconds => outputs.at(-1).listener({event:'timing',seconds,sentSeconds:10,sinkSeconds:10-seconds});
const beginRefill = seconds => {
  holdNext=true;finishOpen=null;
  pipe.append(new Uint8Array(1024));
  clock(seconds);
  renderer.videoReport({id:currentPresentation().id,end:seconds});
};
try {
  renderer.resize(240,180,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://refill.test/',contentType:'text/html',source:
    '<style>body{margin:0}video{width:100px;height:60px;display:block}#second{display:none}</style><video id=v src="clip.mp4"></video><video id=second></video>'});
  await renderer.whenLoaded();
  await renderer.evaluate('document.getElementById("v").play()');
  outputs.at(-1).listener({event:'request',bytes:20000});
  await waitFor(()=>Boolean(currentPresentation()));
  assert.equal(outputs.length,1);

  // A real presentation refills without probing/decoding the same prefix on
  // the page thread. Audio continues to own time and keeps its output stream.
  const firstOpens=opens();
  beginRefill(2);
  await waitFor(()=>Boolean(finishOpen));
  const resumed=decoders.at(-1);
  finishOpen();
  await waitFor(()=>opens()>firstOpens);
  assert.deepEqual(resumed.seeks,[]);
  assert.equal(resumed.frames,0);
  assert.equal(currentPresentation().time,2);
  assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),2);
  assert.equal(outputs.length,1,'refilling does not reset the measured audio stream');

  // Controls enabled during the async reopen prevent presentation: the lazy
  // page decoder must seek before it can draw an ordinary local frame.
  const controlOpens=opens();
  beginRefill(3);
  await waitFor(()=>Boolean(finishOpen));
  await renderer.evaluate('document.getElementById("v").setAttribute("controls", "")');
  const controls=decoders.at(-1);
  finishOpen();
  await waitFor(()=>controls.frames>0);
  assert.ok(controls.seeks.length>0);
  assert.equal(controls.seeks[0],3000);
  assert.equal(opens(),controlOpens);
  assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),3);

  await renderer.evaluate('document.getElementById("v").removeAttribute("controls");document.getElementById("v").style.width="101px"');
  await waitFor(()=>opens()>controlOpens);
  const multipleOpens=opens();
  beginRefill(4);
  await waitFor(()=>Boolean(finishOpen));
  await renderer.evaluate('document.getElementById("second").style.display="block"');
  const multiple=decoders.at(-1);
  finishOpen();
  await waitFor(()=>multiple.frames>0);
  assert.ok(multiple.seeks.length>0);
  assert.equal(multiple.seeks[0],4000);
  assert.equal(opens(),multipleOpens,'multiple visible videos retain local decoding');

  await renderer.evaluate('document.getElementById("second").style.display="none"');
  await waitFor(()=>opens()>multipleOpens);
  const fallback=decoders.at(-1), beforeFallback=fallback.frames;
  renderer.videoReport({id:currentPresentation().id,error:'simulated decoder failure'});
  await waitFor(()=>fallback.frames>beforeFallback);
  assert.ok(fallback.seeks.length>0,'failed presentation positions the page decoder');
  await renderer.evaluate('document.getElementById("v").pause()');
  const paused=await renderer.evaluate('document.getElementById("v").currentTime');
  clock(5);
  assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),paused);
  assert.deepEqual(errors,[]);
  process.stdout.write('presentation refill avoids duplicate page decode and preserves fallbacks\n');
} finally {renderer.dispose();}

// Host scripting globals are isolated from the test runner.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createBytePipe} from '../../lib/media/byte-pipe.js';

const action = process.argv[2], sleep = Bun.sleep, pipe = createBytePipe();
pipe.append(new Uint8Array(1024));
let decodeCount = 0, rejectAudio;
const outputs = [], errors = [];
const renderer = await createPageRenderer({
  onFrame() {}, onVideo() {}, reportError:error => errors.push(String(error)),
  fetchResource:async () => ({ok:true, contentType:'video/mp4', body:pipe}),
  videoDecoder:{
    probe:async () => ({duration:30, video:{width:20,height:12}, audio:{sampleRate:1000}}),
    decode:async () => ({width:20,height:12,fps:10, seek() {}, close() {},
      nextFrame:(w,h) => new Uint8Array(w*h*4)}),
    async decodeAudio() {
      decodeCount++;
      if (decodeCount === 2) await new Promise((resolve, reject) => {rejectAudio=reject;});
      let position = 0;
      return {sampleRate:1000,channels:1, close() {}, nextSamples() {
        if (position >= 1000) return null;
        position += 100;
        return new Float32Array(100);
      }};
    },
  },
  audio:{
    open(options, listener) {outputs.push({listener,bytes:0});return outputs.length;},
    write(id, bytes) {outputs[id-1].bytes+=bytes.length;},
    close(id) {return Promise.resolve(outputs[id-1].bytes);}, finish() {},
  },
});
const waitFor = async condition => {
  for(let n=0;n<200;n++) {if(condition())return;await sleep(5);}
  assert.fail(`timed out: ${condition}`);
};
try {
  renderer.resize(240,180,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://refill-cancel.test/',contentType:'text/html',source:
    '<style>video{width:100px;height:60px;display:block}</style><video id=v src="clip.mp4"></video>'});
  await renderer.whenLoaded();
  await renderer.evaluate('globalThis.mediaEvents=[]; const v=document.getElementById("v"); v.addEventListener("error",()=>mediaEvents.push("error")); v.addEventListener("seeked",()=>mediaEvents.push("seeked")); v.play()');
  // The old snapshot ends at sample 1000; the newer, now-complete input
  // makes the replacement decoder's rejection a fatal error if still active.
  pipe.finish();
  outputs[0].listener({event:'request',bytes:3000});
  await waitFor(() => Boolean(rejectAudio));

  if (action === 'seek') await renderer.evaluate('document.getElementById("v").currentTime=0.2');
  else if (action === 'pause') await renderer.evaluate('document.getElementById("v").pause()');
  else if (action === 'navigate') {
    // The replacement is a static page; it does not need another host realm.
    renderer.setScripting('off');
    await renderer.loadDocument({url:'https://refill-cancel.test/next',contentType:'text/html',source:'<p id=next>Next document</p>'});
    await renderer.whenLoaded();
  } else assert.fail(`unknown action: ${action}`);

  rejectAudio(Error('obsolete failed audio refill'));
  if (action === 'seek') {
    for(let n=0;n<200;n++) {
      if (await renderer.evaluate('mediaEvents.includes("seeked")')) break;
      await sleep(5);
    }
    assert.equal(await renderer.evaluate('mediaEvents.includes("seeked")'),true);
    assert.equal(await renderer.evaluate('document.getElementById("v").paused'),false);
    assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),0.2);
    assert.equal(await renderer.evaluate('mediaEvents.includes("error")'),false);
  } else {
    await sleep(80);
    if (action === 'pause') {
      assert.equal(await renderer.evaluate('document.getElementById("v").paused'),true);
      assert.equal(await renderer.evaluate('mediaEvents.includes("error")'),false);
    } else assert.equal(await renderer.evaluate('document.body.textContent'),'Next document');
  }
  assert.deepEqual(errors,[]);
  assert.equal(decodeCount,2,'an obsolete rejection must not close and reopen the media');
  process.stdout.write(`${action} ignores an obsolete refill rejection\n`);
} finally {renderer.dispose();}

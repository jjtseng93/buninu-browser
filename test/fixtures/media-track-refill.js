// Host scripting globals are isolated from the test runner.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createBytePipe} from '../../lib/media/byte-pipe.js';

const sleep = Bun.sleep, pipe = createBytePipe();
pipe.append(new Uint8Array(1024));
// A shared pipe with MSE-like epochs. Epoch 0's decoder may have more
// frames than its boundary; the renderer must stop it exactly at 3 seconds.
let thirdEpoch = false;
pipe.snapshotAt = time => {
  const id = time < 3 ? 1 : time < 6 || !thirdEpoch ? 2 : 3;
  return {id, startTime:(id-1)*3, endTime:id < 3 ? id*3 : Infinity,
    bytes:new Uint8Array([id, pipe.size / 1024])};
};
const outputs = [], messages = [], audioDecoders = [], errors = [];
let finishVideoOpen, holdVideo = false, failAudio = false;
const renderer = await createPageRenderer({
  onFrame() {}, onVideo:message => messages.push(message),
  fetchResource:async () => ({ok:true, contentType:'video/mp4', body:pipe}),
  reportError:error => errors.push(String(error)),
  videoDecoder:{
    probe:async () => ({duration:30, video:{width:20,height:12}, audio:{sampleRate:1000}}),
    async decode() {
      if (holdVideo) {holdVideo=false; await new Promise(resolve => {finishVideoOpen=resolve;});}
      return {width:20,height:12,fps:10, seek() {}, close() {},
        nextFrame:(w,h) => new Uint8Array(w*h*4)};
    },
    async decodeAudio(bytes) {
      if (failAudio) throw Error('decoder failure after the completed input');
      const start = (bytes[0]-1)*3000;
      const record = {position:start, end:start+bytes[1]*2000, closed:false};
      audioDecoders.push(record);
      return {sampleRate:1000,channels:1, close() {record.closed=true;},
        nextSamples() {
          if (record.position >= record.end) return null;
          return Float32Array.from({length:Math.min(100,record.end-record.position)},
            () => (record.position++ % 1000) / 1024);
        }};
    },
  },
  audio:{
    open(options, listener) {outputs.push({listener,pcm:[]});return outputs.length;},
    write(id, bytes) {outputs[id-1].pcm.push(...new Int16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2));},
    close(id) {return Promise.resolve(outputs[id-1].pcm.length*2);}, finish() {},
  },
});
const current = () => messages.filter(message => message.type === 'video-open').at(-1);
const waitFor = async condition => {
  for(let n=0;n<200;n++) {if(condition())return;await sleep(5);}
  assert.fail(`timed out: ${condition}; ${JSON.stringify({audioDecoders,errors})}`);
};
const clock = seconds => outputs[0].listener({event:'timing',seconds,sentSeconds:10});
const request = samples => outputs[0].listener({event:'request',bytes:samples*2});
const startRefill = time => {
  pipe.append(new Uint8Array(1024));
  holdVideo=true;finishVideoOpen=null;
  clock(time);
  renderer.videoReport({id:current().id,end:time});
};
try {
  renderer.resize(240,180,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://track-refill.test/',contentType:'text/html',source:
    '<style>video{width:100px;height:60px;display:block}</style><video id=v src="clip.mp4"></video>'});
  await renderer.whenLoaded();
  await renderer.evaluate('document.getElementById("v").play()');
  request(500);
  await waitFor(() => Boolean(current()));
  assert.equal(audioDecoders.length,1);
  const first = audioDecoders[0], firstId = current().id;

  // Appending shared bytes does not make the sound decoder unusable. A small
  // request queued behind video's async open must consume that SAME decoder.
  startRefill(0.4);
  await waitFor(() => Boolean(finishVideoOpen));
  request(500);
  finishVideoOpen();
  await waitFor(() => current().id !== firstId && outputs[0].pcm.length === 1000);
  assert.equal(audioDecoders.length,1,'video EOF does not reopen usable audio');
  assert.equal(first.closed,false);
  assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),0.4);

  // Audio reaches its own old snapshot's EOF while draining a request held
  // during another video refill. It must reopen once and continue at sample
  // 2000, preserving both the in-flight request and the output stream.
  const secondId = current().id;
  startRefill(0.5);
  await waitFor(() => Boolean(finishVideoOpen));
  request(1500);
  finishVideoOpen();
  await waitFor(() => current().id !== secondId && outputs[0].pcm.length === 2500);
  assert.equal(audioDecoders.length,2,'audio itself still refills at EOF');
  assert.equal(first.closed,true);
  assert.equal(outputs.length,1,'decoder refill keeps its sample clock/output stream');
  assert.equal(await renderer.evaluate('document.getElementById("v").currentTime'),0.5);

  // An epoch boundary must trigger a new configuration even when the old
  // decoder still has PCM and no new append occurred since its last reopen.
  request(1000);
  await waitFor(() => outputs[0].pcm.length === 3500);
  assert.equal(audioDecoders.length,3);
  assert.equal(audioDecoders[1].closed,true);
  assert.equal(audioDecoders[2].position,3500);
  assert.equal(outputs.length,1);
  for(let i=0;i<3500;i++) assert.equal(outputs[0].pcm[i],Math.round((i%1000)/1024*32767),`sample ${i}`);
  assert.deepEqual(errors,[]);

  // An exhausted range with no different snapshot must wait for an append,
  // without reopening that same epoch in a loop. Then resume at its exact
  // next sample when a genuinely different epoch arrives.
  request(3000);
  await sleep(80);
  assert.equal(outputs[0].pcm.length,6000);
  assert.equal(audioDecoders.length,3);
  thirdEpoch=true;
  pipe.append(new Uint8Array(1024));
  await waitFor(() => outputs[0].pcm.length === 6500);
  assert.equal(audioDecoders.length,4);
  assert.equal(outputs.length,1);
  for(let i=3500;i<6500;i++) assert.equal(outputs[0].pcm[i],Math.round((i%1000)/1024*32767),`sample ${i}`);

  // Exhausting a finished input must surface a subsequent decoder failure,
  // rather than treating it as another append or swallowing the error.
  pipe.finish(); failAudio=true;
  request(9000);
  await waitFor(() => errors.length > 0);
  assert.match(errors[0],/decoder failure after the completed input/);
  await sleep(80);
  assert.equal(errors.length,1,'fatal refill is reported once instead of restarting an EOF loop');
  assert.equal(await renderer.evaluate('document.getElementById("v").paused'),true);
  process.stdout.write('track-independent refill integration passed\n');
} finally {renderer.dispose();}

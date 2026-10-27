import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {createMediaSourceScope} from '../../lib/renderer/media-source.js';
import {createWebMStream} from '../../lib/media/webm-stream.js';
import {floatToS16} from '../../lib/audio/pcm.js';
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';

const sleep=Bun.sleep, tasks=[];
await wasmpeg.load();
const fixture=await Bun.file(new URL('./mse-audio-chirp.webm',import.meta.url)).bytes();
const elements=createWebMStream().append(fixture),clusters=elements.filter(e=>e.id===0x1f43b675);
const scope=createMediaSourceScope({origin:'https://gap.test',DOMException,schedule:fn=>tasks.push(fn)});
const flush=()=>{while(tasks.length)tasks.shift()()};
const source=new scope.MediaSource();source.attach('blob:https://gap.test/audio');flush();
const buffer=source.addSourceBuffer('audio/webm; codecs="opus"');
for(const e of [...elements.slice(0,elements.indexOf(clusters[0])),clusters[0],clusters[3]]){buffer.appendBuffer(e.bytes);flush();}
const pipe=buffer._pipe, selected=pipe.snapshotAt(7);
const reference=await wasmpeg.decodeAudio(selected.bytes,{format:'webm'});
let skip=Math.round((7-selected.startTime)*reference.sampleRate),expected;
try {for(let samples;samples=reference.nextSamples();){if(skip>=samples.length){skip-=samples.length;continue;}expected=floatToS16(samples.subarray(skip,skip+100));break;}}
finally{reference.close();}
const outputs=[],errors=[];
const renderer=await createPageRenderer({
  fetchResource:async()=>({ok:true,body:pipe,contentType:'audio/webm'}),videoDecoder:wasmpeg,
  reportError:error=>errors.push(String(error)),
  audio:{open(options,listener){outputs.push({listener,pcm:[]});return outputs.length;},
    write(id,bytes){outputs[id-1].pcm.push(bytes.slice());},finish(){},close(){return Promise.resolve(0);}},
});
const wait=async condition=>{for(let i=0;i<200;i++){if(await condition())return;await sleep(5);}assert.fail(`timed out; ${errors}`);};
try{
  renderer.setScripting('host');
  await renderer.loadDocument({url:'https://gap.test/',contentType:'text/html',source:'<audio id=a src="sparse.webm"></audio>'});
  await renderer.evaluate('document.getElementById("a").play()');
  assert.equal(outputs.length,1);outputs[0].listener({event:'request',bytes:4800});
  outputs[0].listener({event:'timing',seconds:.025,sentSeconds:.05});
  await renderer.evaluate('globalThis.seekDone=0;const a=document.getElementById("a");a.addEventListener("seeked",()=>seekDone++);a.currentTime=7');
  await wait(()=>outputs.length===2);
  assert.equal(await renderer.evaluate('seekDone'),1,'the sparse seek completed');
  outputs[1].listener({event:'request',bytes:200});
  assert.deepEqual(outputs[1].pcm[0],expected,'resumed stream begins at the original timeline sample');
  outputs[1].listener({event:'timing',seconds:.001,sentSeconds:.002});
  assert.equal(await renderer.evaluate('document.getElementById("a").currentTime'),7.001);
  await renderer.evaluate('document.getElementById("a").pause();document.getElementById("a").currentTime=.5');
  await wait(async()=>await renderer.evaluate('seekDone')===2);
  assert.equal(await renderer.evaluate('document.getElementById("a").currentTime'),.5);
  assert.equal(outputs.length,2,'paused backwards seek does not open output');
  await renderer.evaluate('document.getElementById("a").play()');
  assert.equal(outputs.length,3,'play after backwards seek reopens audio normally');
  assert.deepEqual(errors,[]);
  process.stdout.write('sparse WebM seek and playback passed\n');
}finally{pipe.finish();renderer.dispose();}

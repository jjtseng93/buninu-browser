// Isolate host scripting globals and model the decoder's bounded session pool.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

let active=0,opened=0,closed=0;
const outputs=[],errors=[];
const renderer=await createPageRenderer({
  fetchResource:async url=>({ok:true,contentType:'audio/mpeg',body:new Uint8Array([url.includes('background')?1:2])}),
  reportError:error=>errors.push(String(error)),
  videoDecoder:{
    probe:async bytes=>({duration:bytes[0]===1?100:0.1,audio:{sampleRate:1000}}),
    async decodeAudio(bytes){
      if(active>=8)throw Error('audio decoder session pool exhausted');
      active++;opened++;
      let remaining=bytes[0]===1?100000:100,disposed=false;
      return {sampleRate:1000,channels:1,
        nextSamples(){assert.equal(disposed,false);if(!remaining)return null;const size=Math.min(100,remaining);remaining-=size;return new Float32Array(size).fill(.25);},
        close(){assert.equal(disposed,false,'each decoder closes once');disposed=true;active--;closed++;},
      };
    },
  },
  audio:{
    open(options,listener){outputs.push({listener,samples:0});return outputs.length;},
    write(id,bytes){outputs[id-1].samples+=bytes.length/2;},
    finish(id){queueMicrotask(()=>outputs[id-1].listener({event:'ended'}));},
    close(id){return Promise.resolve(outputs[id-1].samples*2);},
  },
});
const evaluate=source=>renderer.evaluate(source);
const waitFor=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await Bun.sleep(5);}assert.fail('audio did not finish');};
async function finishSound(){
  const output=outputs.at(-1);
  output.listener({event:'request',bytes:1000});
  await waitFor(()=>evaluate('effect.ended'));
  assert.equal(output.samples,100);
  assert.equal(await evaluate('effect.currentTime'),.1);
  assert.equal(await evaluate('effect.error'),null);
  assert.equal(await evaluate('background.paused'),false);
  assert.equal(active,1,'only the playing background decoder remains after each sound ends');
}
try{
  renderer.setScripting('host');
  await renderer.loadDocument({url:'https://audio-lifetime.test/',contentType:'text/html',source:'<body></body>'});
  await evaluate(`globalThis.background=new Audio('background.mp3');background.play()`);
  assert.equal(active,1);
  // Games can retain dozens of short-lived Audio objects without asking them
  // to release a decoder explicitly. Keeping those DOM objects is harmless.
  await evaluate('globalThis.saved=[]');
  for(let i=0;i<12;i++){
    await evaluate(`globalThis.effect=new Audio('effect.mp3');saved.push(effect);effect.play()`);
    assert.equal(active,2);
    await finishSound();
  }
  // Released decoders must be reconstructed for replay and for a seek.
  await evaluate('effect.play()');await finishSound();
  await evaluate('effect.currentTime=0');
  await waitFor(()=>evaluate('effect.readyState>=2'));
  await evaluate('effect.play()');await finishSound();
  assert.equal(opened,15);
  assert.equal(closed,14);
  assert.deepEqual(errors,[]);
  process.stdout.write('audio decoder lifetime integration passed\n');
}finally{renderer.dispose();}
assert.equal(active,0,'navigation/disposal releases the background too');
assert.equal(closed,opened);

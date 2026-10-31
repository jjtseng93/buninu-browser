import assert from 'node:assert/strict';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';

const mode=process.argv[2]??'ses';
if(mode==='ses'){
  await import('../../vendor/ses/dist/ses.mjs');await loadGraphics();
  lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
}
const outputs=[],closed=[],errors=[];
const renderer=await createPageRenderer({reportError:error=>errors.push(String(error)),audio:{
  open(options,listener){outputs.push({options,listener,pcm:[]});return outputs.length;},
  write(id,bytes){outputs[id-1].pcm.push(new Int16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2).slice());},
  close(id){closed.push(id);return Promise.resolve();},
}});
try{
  renderer.setScripting(mode);
  await renderer.loadDocument({url:'https://web-audio.test/',contentType:'text/html',source:'<body>Web Audio</body>'});
  const result=await renderer.evaluate(`(()=>{
    globalThis.c=new AudioContext({sampleRate:8000});globalThis.other=new webkitAudioContext({sampleRate:8000});
    globalThis.osc=c.createOscillator();globalThis.gain=c.createGain();
    osc.frequency.setValueAtTime(500,c.currentTime);gain.gain.value=.25;
    osc.connect(gain).connect(c.destination);osc.start();globalThis.ends=0;osc.onended=()=>ends++;
    return {context:c instanceof BaseAudioContext,node:osc instanceof AudioScheduledSourceNode,eventTarget:osc instanceof EventTarget,
      param:osc.frequency instanceof AudioParam,alias:AudioContext===webkitAudioContext,name:AudioContext.name,
      native:AudioContext.prototype.createOscillator.toString().includes('[native code]'),
      output:osc.context===c&&gain.context===c,state:c.state};
  })()`);
  assert.deepEqual(result,{context:true,node:true,eventTarget:true,param:true,alias:true,name:'AudioContext',native:mode==='ses',output:true,state:'running'});
  assert.equal(outputs.length,2);
  assert.deepEqual(outputs[0].options,{rate:8000,channels:2,name:'Web Audio'});
  outputs[0].listener({event:'request',bytes:512});
  assert.ok(Math.abs(outputs[0].pcm[0][8]-8192)<=1,'real page graph produces the expected sine samples');
  assert.equal(await renderer.evaluate('c.currentTime'),.016);
  await renderer.evaluate('c.suspend()');assert.deepEqual(closed,[1]);
  await renderer.evaluate('c.resume()');assert.equal(outputs.length,3);
  await renderer.evaluate('osc.stop()');outputs[2].listener({event:'request',bytes:512});
  await Bun.sleep(30);assert.equal(await renderer.evaluate('ends'),1);
  assert.ok(outputs[2].pcm[0].every(x=>x===0));
  await renderer.loadDocument({url:'https://web-audio.test/next',contentType:'text/html',source:'<p>next</p>'});
  assert.deepEqual(closed.sort(),[1,2,3],'navigation closes every document-owned context');
  const count=outputs[2].pcm.length;outputs[2].listener({event:'request',bytes:512});
  assert.equal(outputs[2].pcm.length,count,'stale requests cannot revive an old graph');
  assert.deepEqual(errors,[]);
  process.stdout.write(`${mode} Web Audio page PCM and disposal passed\n`);
}finally{renderer.dispose();}

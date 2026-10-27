// Host scripting installs browser globals; isolate each explicit selection.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

const action=process.argv[2],fetches=[],errors=[];
let finishProbe,holdProbe=true,probes=0;
const renderer=await createPageRenderer({
  fetchResource:async url=>{
    fetches.push(url);
    if(url.startsWith('blob:'))throw Error('expired object URL');
    return {ok:true,contentType:'video/mp4',body:new Uint8Array(1024)};
  },
  videoDecoder:{
    async probe(){
      probes++;
      if(holdProbe)await new Promise(resolve=>{finishProbe=resolve;});
      return {duration:10,video:{width:20,height:12}};
    },
    async decode(){return {width:20,height:12,fps:10,close(){},seek(){},nextFrame:()=>new Uint8Array(20*12*4)};},
  },
  reportError:error=>errors.push(String(error)),
});
const evaluate=source=>renderer.evaluate(source);
const waitFor=async condition=>{
  for(let n=0;n<200;n++){if(await condition())return;await Bun.sleep(5);}
  assert.fail(`timed out: ${condition}; fetches=${fetches}, errors=${errors}`);
};
try{
  renderer.resize(200,120,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://selection.test/',contentType:'text/html',source:
    '<base href="https://selection.test/first/"><video id=v></video>'});
  await renderer.whenLoaded();
  await evaluate(`globalThis.v=document.getElementById('v');v.src='clip.mp4';void v.play();`);
  await waitFor(()=>Boolean(finishProbe));
  await evaluate(`document.querySelector('base').href='https://selection.test/second/';`);
  finishProbe();
  await waitFor(()=>evaluate('v.duration===10'));
  assert.deepEqual(fetches,['https://selection.test/first/clip.mp4'],
    'base alone must preserve the resource chosen before the pending probe');
  await evaluate('v.pause();void v.play();');
  assert.equal(fetches.length,1,'ordinary play must not reselect because base changed');

  finishProbe=null;
  await evaluate('v.pause()');
  if(action==='src')await evaluate(`v.src='clip.mp4';`);
  else if(action==='attribute')await evaluate(`v.setAttribute('src','clip.mp4');`);
  else if(action==='load')await evaluate('v.load()');
  else assert.fail(`unknown action ${action}`);
  assert.equal(await evaluate('v.paused'),true);
  if(action!=='load')await evaluate('void v.play()');
  await waitFor(()=>Boolean(finishProbe));
  assert.deepEqual(fetches,['https://selection.test/first/clip.mp4','https://selection.test/second/clip.mp4']);
  finishProbe();
  await waitFor(()=>evaluate('v.duration===10'));

  if(action==='load'){
    assert.equal(await evaluate('v.paused'),true,'load must not start playback');
    finishProbe=null;
    await evaluate('v.load()');
    await waitFor(()=>Boolean(finishProbe));
    assert.equal(fetches.length,3,'load explicitly reloads even an unchanged resolved URL');
    finishProbe();await waitFor(()=>evaluate('v.duration===10'));
    holdProbe=false;

    // srcObject wins over both the property and attribute setters, including
    // explicit load. A real object never needs its object URL registry entry.
    await evaluate(`globalThis.ms=new MediaSource();v.srcObject=ms;
      globalThis.append=source=>{const sb=source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"');
        const bytes=new Uint8Array(1024);new DataView(bytes.buffer).setUint32(0,1024);bytes.set([109,100,97,116],4);sb.appendBuffer(bytes);};
      append(ms);`);
    await waitFor(()=>evaluate('v.duration===10'));
    await evaluate(`v.src='ignored.mp4';v.setAttribute('src','also-ignored.mp4');v.load();`);
    await waitFor(()=>evaluate('v.readyState>=3'));
    assert.equal(fetches.length,3);
    assert.equal(await evaluate('v.srcObject===ms'),true);

    // Revocation is harmless until an explicit load starts a new selection.
    await evaluate(`v.srcObject=null;globalThis.other=new MediaSource();v.src=URL.createObjectURL(other);append(other);`);
    await waitFor(()=>evaluate('v.duration===10'));
    await evaluate('URL.revokeObjectURL(v.src);other.duration=20');
    assert.equal(await evaluate('v.duration'),20);
    await evaluate('v.load()');
    await waitFor(()=>errors.length===1);
    assert.equal(fetches.length,4);
    assert.match(fetches[3],/^blob:/);
    const before=probes;
    await evaluate('other.duration=30;append(other)');
    await Bun.sleep(30);
    assert.equal(probes,before,'a revoked source cannot reattach through a late append');
    assert.equal(await evaluate('Number.isNaN(v.duration)'),true);
    assert.match(errors[0],/expired object URL/);
  }else assert.deepEqual(errors,[]);
  process.stdout.write(`Media resource reselection ${action} passed\n`);
}finally{renderer.dispose();}

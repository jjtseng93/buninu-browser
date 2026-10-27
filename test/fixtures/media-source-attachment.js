// Host scripting installs browser globals; keep this fixture isolated.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

const sleep=Bun.sleep, probes=[],errors=[],fetches=[];
let finishProbe;
const renderer=await createPageRenderer({
  fetchResource:async url=>{
    fetches.push(url);const body=new Uint8Array(1024);body[8]=10;
    return {ok:true,contentType:'video/mp4',body};
  },
  videoDecoder:{
    async probe(bytes) {
      probes.push(bytes[8]);
      if(bytes[8]===8||bytes[8]===10)await new Promise(resolve=>{finishProbe=resolve;});
      return {duration:bytes[8]*100,video:{width:20,height:12}};
    },
    async decode() {return {width:20,height:12,fps:10,close(){},seek(){},nextFrame:()=>new Uint8Array(20*12*4)};},
  },
  reportError:error=>errors.push(String(error)),
});
const evaluate=source=>renderer.evaluate(source);
const duration=()=>evaluate('document.getElementById("v").duration');
const waitFor=async condition=>{
  for(let n=0;n<200;n++){if(await condition())return;await sleep(5);}
  assert.fail(`timed out: ${condition}; probes=${probes}, errors=${errors}`);
};
try {
  renderer.resize(200,120,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://attachment.test/',contentType:'text/html',source:'<video id=v></video>'});
  await renderer.whenLoaded();
  await evaluate(`
    globalThis.sources=[];globalThis.buffers=[];
    globalThis.makeSource=()=>{const source=new MediaSource();sources.push(source);return source;};
    globalThis.append=(source,marker)=>{
      let buffer=buffers.find(entry=>entry.source===source)?.buffer;
      if(!buffer){buffer=source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"');buffers.push({source,buffer});}
      const bytes=new Uint8Array(1024);new DataView(bytes.buffer).setUint32(0,bytes.length);
      bytes.set([109,100,97,116],4);bytes[8]=marker;buffer.appendBuffer(bytes);
    };
    globalThis.a=makeSource();globalThis.b=makeSource();
    document.getElementById('v').src=URL.createObjectURL(a);a.duration=59.201;
    append(a,1);
  `);
  await waitFor(()=>probes.length===1);
  assert.equal(await duration(),59.201);
  await evaluate(`document.getElementById('v').src=URL.createObjectURL(b);b.duration=1000;append(b,2);`);
  await waitFor(()=>probes.length===2);
  assert.equal(await duration(),1000);

  // Regression: the former source still exists in JS and can finish work,
  // but it no longer owns this media element's current state.
  await evaluate('a.duration=59.201');
  assert.equal(await duration(),1000,'old source duration must not overwrite the current source');
  await evaluate('append(a,3)');
  await sleep(40);
  assert.equal(probes.length,2,'old append must not probe or rebind the current track pipes');
  await evaluate('a.endOfStream()');
  assert.equal(await duration(),1000,'old source end must not restore its shorter duration');
  await evaluate('b.duration=1100');
  assert.equal(await duration(),1100);

  // A new source with unknown duration starts a new state: the previous
  // explicit-duration override cannot suppress its own metadata probe.
  await evaluate(`globalThis.c=makeSource();document.getElementById('v').src=URL.createObjectURL(c);append(c,7);`);
  await waitFor(()=>probes.length===3);
  assert.equal(await duration(),700,'new source metadata must replace the old duration override');
  await evaluate('b.duration=17');
  assert.equal(await duration(),700);

  // srcObject takes precedence over the src attribute; replacing an object
  // must also replace state even though that attribute's URL has not changed.
  await evaluate(`globalThis.d=makeSource();document.getElementById('v').srcObject=d;d.duration=800;`);
  assert.equal(await duration(),800);
  await evaluate(`globalThis.e=makeSource();document.getElementById('v').src=URL.createObjectURL(e);`);
  assert.equal(await duration(),800,'changing src must not displace an active srcObject');
  assert.equal(await evaluate('e.readyState'),'closed');
  await evaluate('c.duration=11');
  assert.equal(await duration(),800);
  await evaluate('document.getElementById("v").srcObject=null;e.duration=900;');
  assert.equal(await duration(),900,'clearing srcObject activates the src attribute');
  await evaluate('d.duration=12');
  assert.equal(await duration(),900);
  await evaluate(`globalThis.f=makeSource();document.getElementById('v').srcObject=f;append(f,6);`);
  await waitFor(()=>probes.length===4);
  assert.equal(await duration(),600,'new srcObject must not inherit a previous duration override');
  await evaluate('e.duration=13');
  assert.equal(await duration(),600);
  await evaluate(`URL.createObjectURL(f);document.getElementById('v').src='unused.mp4';`);
  assert.equal(await duration(),600,'an alias and an inactive src must not reset a live srcObject');

  // Revocation prevents a future URL lookup; it does not detach the source
  // already selected by the media element. Both callbacks still work.
  await evaluate(`document.getElementById('v').src=URL.createObjectURL(e);document.getElementById('v').srcObject=null;URL.revokeObjectURL(document.getElementById('v').src);e.duration=1200;append(e,4);`);
  await waitFor(()=>probes.length===5);
  assert.equal(await duration(),1200);
  await evaluate('e.duration=1300');
  assert.equal(await duration(),1300);

  // A probe already in flight for an old attachment cannot commit metadata
  // to the replacement resource or emit its loadedmetadata on the new src.
  await evaluate(`globalThis.g=makeSource();document.getElementById('v').src=URL.createObjectURL(g);append(g,8);`);
  await waitFor(()=>Boolean(finishProbe));
  await evaluate(`globalThis.h=makeSource();document.getElementById('v').src=URL.createObjectURL(h);h.duration=1400;
    globalThis.metadataEvents=0;document.getElementById('v').addEventListener('loadedmetadata',()=>metadataEvents++);`);
  finishProbe();await sleep(40);
  assert.equal(await duration(),1400);
  assert.equal(await evaluate('metadataEvents'),0);

  // A base-URL change alone must not cancel an already selected relative
  // resource while its metadata probe is pending.
  finishProbe=null;
  await evaluate(`const base=document.createElement('base');base.href='https://attachment.test/first/';document.head.appendChild(base);
    document.getElementById('v').src='clip.mp4';void document.getElementById('v').play();`);
  await waitFor(()=>Boolean(finishProbe));
  await evaluate(`document.querySelector('base').href='https://attachment.test/second/';`);
  finishProbe();
  await waitFor(async()=>await duration()===1000);
  assert.deepEqual(fetches,['https://attachment.test/first/clip.mp4']);
  assert.equal(await evaluate('document.getElementById("v").paused'),false);

  // Old document callbacks must not create a new hidden media state in the
  // replacement document. Keep only the original source/append closures.
  const old={source:globalThis.h,append:globalThis.append};
  // Host mode installs globals process-wide and permits just one realm here.
  // The destination is static; stale callbacks must still be harmless.
  renderer.setScripting('off');
  await renderer.loadDocument({url:'https://attachment.test/next',contentType:'text/html',source:'<video id=v></video>'});
  await renderer.whenLoaded();
  const before=probes.length;
  old.source.duration=3;old.append(old.source,9);
  await sleep(40);
  assert.equal(probes.length,before,'old document append must not start a probe');
  assert.deepEqual(errors,[]);
  process.stdout.write('MediaSource attachment isolation passed\n');
} finally {renderer.dispose();}

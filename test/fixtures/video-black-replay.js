import assert from 'node:assert/strict';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
import {compositeVideo} from '../../lib/renderer/video-presentation.js';
import {captureViewport} from '../../lib/paint/frame.js';

const {CanvasKit:kit} = await loadGraphics();
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
let readbacks = 0, checks = 0;
const makeSurface = kit.MakeSurface;
kit.MakeSurface = (...args) => {
  const surface = makeSurface(...args), snapshot = surface.makeImageSnapshot.bind(surface);
  surface.makeImageSnapshot = () => {
    const image = snapshot(), read = image.readPixels.bind(image);
    image.readPixels = (...args) => { readbacks++; return read(...args); };
    return image;
  };
  return surface;
};
const source = `<style>body{margin:0;background:#182331;color:white;height:500px}
#wrap{position:absolute;left:12px;top:14px;width:160px;height:90px;overflow:hidden;border-radius:13px}
video{display:block;width:160px;height:90px}#caption{position:absolute;left:5px;top:55px;background:#6548;font:12px sans-serif}
#marker{position:absolute;left:210px;top:10px;width:25px;height:15px;background:red}
#shadow{position:absolute;left:180px;top:15px;width:5px;height:50px;box-shadow:-5px 3px 12px #0009}
</style><div id=wrap><video id=v src=clip.mp4></video><span id=caption>Caption</span></div><div id=marker></div><div id=shadow></div>`;
function framePixels(alpha) {
  const pixels = new Uint8Array(32*18*4);
  for (let i=0;i<pixels.length;i+=4) pixels.set([(i*37+13)%256,(i*17+71)%256,(i*53+119)%256,i%20===0?alpha:255],i);
  return pixels;
}
async function makeClient(alpha) {
  const client = {messages:[],errors:[],tile:null,frame:null};
  client.renderer = await createPageRenderer({renderMinInterval:1000,
    allocateFramePixels:bytes=>new Uint8Array(new SharedArrayBuffer(bytes)),
    onFrame:frame=>{client.tile=frame.tile;},onVideo:message=>client.messages.push(message),
    reportError:error=>client.errors.push(String(error)),
    fetchResource:async url=>({ok:true,url,body:new Uint8Array([1]),contentType:'video/mp4'}),
    videoDecoder:{probe:async()=>({duration:100,video:{width:32,height:18}}),
      decode:async()=>({width:32,height:18,fps:30,nextFrame:()=>framePixels(alpha),seek(){},close(){}})},
  });
  client.renderer.setScripting('ses');client.renderer.resize(320,220,1.25);
  return client;
}
async function load(client,suffix='') {
  await client.renderer.loadDocument({url:'https://video.test/'+suffix,contentType:'text/html',source});
  await client.renderer.whenLoaded();await client.renderer.evaluate("document.getElementById('v').play()");
  await layer(client);
}
async function layer(client) {
  for (let i=0;i<100&&!client.tile?.videoLayer;i++) { await Bun.sleep(5); await client.renderer.screenshot({format:'rgba'}); }
  assert.ok(client.tile?.videoLayer,'independent presentation exists');
}
function seed(client,alpha,serial=2) {
  const message = client.messages.findLast(message=>message.type==='video-open'&&message.id===client.tile.videoLayer.id);
  const meta = new Int32Array(message.shared,0,4), pixels = framePixels(alpha);
  Atomics.store(meta,0,serial-1);new Uint8Array(message.shared,16,pixels.length).set(pixels);
  Atomics.store(meta,1,32);Atomics.store(meta,2,18);Atomics.store(meta,0,serial);
  client.frame = {pixels,width:32,height:18};
  return {meta,shared:message.shared};
}

for (const alpha of [255,127]) {
  // The reference never receives a shared frame, so it takes the original
  // Skia ordinary pass and both mask passes, using identical decoder pixels.
  const reference = await makeClient(alpha), candidate = await makeClient(alpha), clients = [reference,candidate];
  async function mutate(expression) { for (const client of clients) await client.renderer.evaluate(expression); }
  function compare(label,fast=alpha===255) {
    const before = reference.tile, after = candidate.tile;
    assert.ok(after.pixels.buffer instanceof SharedArrayBuffer,label+' allocator ownership');
    assert.equal(Boolean(after.videoLayer),Boolean(before.videoLayer),label+' eligibility');
    if (before.videoLayer) {
      assert.deepEqual(after.videoLayer.rect,before.videoLayer.rect,label+' rect');
      assert.deepEqual(after.videoLayer.base,before.videoLayer.base,label+' base');
      assert.deepEqual(after.videoLayer.mask,before.videoLayer.mask,label+' mask');
    }
    const expected = fast&&before.videoLayer ? compositeVideo(before,candidate.frame).pixels : before.pixels;
    assert.deepEqual(after.pixels,expected,label+' pixels');checks++;
  }
  async function repaint(label,expression,fast=alpha===255) {
    await mutate(expression);compare(label,fast);
  }
  try {
    for (const client of clients) await load(client);
    seed(candidate,alpha);
    const before = readbacks;
    await reference.renderer.evaluate("document.getElementById('marker').style.background='orange'");
    const referenceReads = readbacks-before;
    const middle = readbacks;
    await candidate.renderer.evaluate("document.getElementById('marker').style.background='orange'");
    assert.equal(referenceReads,3);assert.equal(readbacks-middle,alpha===255?2:3);compare('warm');
    const oldTile = candidate.tile, oldPixels = oldTile.pixels.slice(), oldBase = oldTile.videoLayer.base.slice(), oldMask = oldTile.videoLayer.mask.slice();
    const raw = await candidate.renderer.screenshot({format:'rgba'});
    assert.deepEqual(raw.pixels,captureViewport(candidate.tile,0,0,320,220).pixels);
    assert.notEqual(raw.pixels.buffer,candidate.tile.pixels.buffer);
    const bgra = await candidate.renderer.screenshot({format:'bgra'}), swapped = raw.pixels.slice();
    for (let i=0;i<swapped.length;i+=4) { const red=swapped[i];swapped[i]=swapped[i+2];swapped[i+2]=red; }
    assert.deepEqual(bgra.pixels,swapped);
    const canvasPixels = [];
    for (const client of clients) canvasPixels.push(await client.renderer.evaluate(`var copy=document.createElement('canvas');copy.width=32;copy.height=18;var cx=copy.getContext('2d');cx.drawImage(document.getElementById('v'),0,0,32,18);Array.from(cx.getImageData(0,0,32,18).data)`));
    assert.deepEqual(canvasPixels[0],canvasPixels[1],'native video image remains available');
    for (const [label,expression] of [
      ['outside',"document.getElementById('marker').style.background='blue'"],
      ['caption',"document.getElementById('caption').textContent='Changed text'"],
      ['selection',"var t=document.getElementById('caption').firstChild;getSelection().setBaseAndExtent(t,0,t,5)"],
      ['selection-clear',"getSelection().removeAllRanges()"],
      ['opacity',"document.getElementById('wrap').style.opacity='.6'"],
      ['rounded',"document.getElementById('wrap').style.borderRadius='21px'"],
      ['transform',"document.getElementById('wrap').style.transform='scale(.9) translateX(7.3px)'"],
      ['shadow',"document.getElementById('shadow').style.boxShadow='-8px 3px 20px #000b'"],
    ]) await repaint(label,expression);
    assert.deepEqual(oldTile.pixels,oldPixels);assert.deepEqual(oldTile.videoLayer.base,oldBase);assert.deepEqual(oldTile.videoLayer.mask,oldMask);
    // A writer's odd serial must leave the previous coherent native/frame pair.
    const message = candidate.messages.findLast(message=>message.type==='video-open');
    Atomics.store(new Int32Array(message.shared,0,4),0,3);
    new Uint8Array(message.shared,16,32*18*4).fill(0);
    await repaint('incomplete-shared-frame',"document.getElementById('marker').style.background='lime'");
    seed(candidate,alpha,4);
    // Controls alone currently need a separate layout invalidation to refresh
    // their display-list bit, so force geometry here to exercise the fallback.
    await repaint('controls',"document.getElementById('v').controls=true;document.getElementById('marker').style.width='26px'",false);
    assert.equal(candidate.tile.videoLayer,null);
    await mutate("document.getElementById('v').controls=false;document.getElementById('marker').style.width='27px'");
    for (const client of clients) await layer(client);seed(candidate,alpha);
    await repaint('controls-restored',"document.getElementById('marker').style.background='cyan'");
    await repaint('two-videos',"var extra=document.createElement('video');extra.id='extra';document.body.append(extra)",false);
    assert.equal(candidate.tile.videoLayer,null);
    await mutate("document.getElementById('extra').remove()");
    for (const client of clients) await layer(client);seed(candidate,alpha);
    await repaint('one-video-restored',"document.getElementById('marker').style.background='pink'");
    await repaint('paused',"document.getElementById('v').pause()",false);
    assert.equal(candidate.tile.videoLayer,null);
    await mutate("document.getElementById('v').play()");
    for (const client of clients) await layer(client);seed(candidate,alpha);
    await repaint('resumed',"document.getElementById('marker').style.background='brown'");
    for (const client of clients) await load(client,'next');seed(candidate,alpha);
    await repaint('navigation',"document.getElementById('marker').style.background='orange'");
    for (const client of clients) assert.deepEqual(client.errors,[]);
  } finally { for (const client of clients) client.renderer.dispose(); }
}
console.log(`video black replay integration passed: ${checks} paired states`);

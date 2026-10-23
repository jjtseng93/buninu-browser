import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
const mode = process.argv[2] ?? 'local';
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==', 'base64');
const renderer = await createPageRenderer({ reportError: error => console.error(error),
  fetchResource: async url => ({ ok: true, status: 200, url, body: redPng }),
});
renderer.resize(400, 300, 1);
renderer.setScripting('host');
const source = 'import QtQuick\nRectangle { width: 400; height: 300; color: "white" }';
const evaluate = code => renderer.evaluate(code);
const pixel = (x, y) => evaluate(`[...ctx.getImageData(${x},${y},1,1).data]`);
const setup = `
  globalThis.outer=document.createElement('div');
  outer.style.cssText='position:absolute;left:50px;top:60px;width:10px;height:10px;overflow:hidden;opacity:0.2';
  document.body.appendChild(outer);
  globalThis.src=document.createElement('div');
  src.style.cssText='position:relative;width:40px;height:30px;background:red';
  outer.appendChild(src);
  const child=document.createElement('div');
  child.style.cssText='position:absolute;left:20px;top:0;width:20px;height:30px;background:blue;z-index:2';
  src.appendChild(child);
  const overlay=document.createElement('div');
  overlay.style.cssText='position:absolute;left:0;top:0;width:400px;height:300px;background:lime;z-index:99';
  document.body.appendChild(overlay);
  globalThis.dest=document.createElement('canvas');dest.width=80;dest.height=60;
  globalThis.ctx=dest.getContext('2d');
`;
try {
  const url = mode === 'local' ? 'file:///tmp/qml-canvas-test.qml' : mode === 'html' ? 'file:///tmp/plain.html' : 'https://qml.test/main.qml';
  await renderer.loadDocument({ url, contentType: mode === 'html' ? 'text/html' : 'text/x-qml', source: mode === 'html' ? '<body></body>' : source });
  await renderer.whenLoaded();
  await evaluate(setup);
  if (mode !== 'local') {
    await evaluate('document.__qmlHost={};globalThis.__qmlHost={};ctx.drawImage(src,0,0)');
    assert.deepEqual(await pixel(5, 5), [0, 0, 0, 0], 'no DOM capture capability');
  } else {
  const before = await evaluate('outer.style.cssText+src.style.cssText');
  await evaluate('ctx.drawImage(src,0,0)');
  assert.deepEqual(await pixel(5, 5), [255, 0, 0, 255], 'no ancestor opacity/clip or sibling overlay');
  assert.deepEqual(await pixel(25, 5), [0, 0, 255, 255], 'internal stacking retained');
  assert.equal(await evaluate('outer.style.cssText+src.style.cssText'), before, 'source DOM untouched');
  assert.deepEqual(await pixel(45, 5), [0, 0, 0, 0], 'intrinsic DOM border-box dimensions');
  await evaluate('src.style.background="yellow"');
  assert.deepEqual(await pixel(5, 5), [255, 0, 0, 255], 'snapshot remains frozen');
  await evaluate('ctx.clearRect(0,0,80,60);ctx.drawImage(src,0,0,80,60)');
  assert.deepEqual(await pixel(35, 20), [255, 255, 0, 255], 'mutation and scaling');
  assert.deepEqual(await pixel(45, 20), [0, 0, 255, 255]);
  await evaluate('ctx.clearRect(0,0,80,60);ctx.drawImage(src,20,0,20,30,10,10,20,30)');
  assert.deepEqual(await pixel(15, 15), [0, 0, 255, 255], '9-argument source cropping');
  assert.deepEqual(await pixel(5, 5), [0, 0, 0, 0]);
  assert.equal(await evaluate('outer.style.opacity'), '0.2');
  assert.equal(await evaluate('src.parentNode===outer'), true);
  // The source's own clipping still applies, unlike outside ancestor clips.
  await evaluate(`src.style.overflow='hidden';src.firstChild.style.left='35px';
    ctx.clearRect(0,0,80,60);ctx.drawImage(src,0,0)`);
  assert.deepEqual(await pixel(38, 5), [0, 0, 255, 255]);
  assert.deepEqual(await pixel(42, 5), [0, 0, 0, 0]);
  await evaluate(`globalThis.nested=document.createElement('canvas');nested.width=nested.height=10;
    nested.style.cssText='position:absolute;left:0;top:0;width:10px;height:10px';
    src.appendChild(nested);const nc=nested.getContext('2d');nc.fillStyle='lime';nc.fillRect(0,0,10,10);
    ctx.clearRect(0,0,80,60);ctx.drawImage(src,0,0)`);
  assert.deepEqual(await pixel(5, 5), [0, 255, 0, 255], 'nested canvas uses its latest native image');
  await evaluate('ctx.clearRect(0,0,80,60);ctx.translate(10,10);ctx.globalAlpha=0.5;ctx.drawImage(src,0,0);ctx.resetTransform();ctx.globalAlpha=1');
  const blended = await pixel(15, 15);
  assert.equal(blended[1], 255);assert.ok(blended[3] >= 127 && blended[3] <= 128);
  assert.equal(await evaluate(`(()=>{src.appendChild(dest);try{ctx.drawImage(src,0,0);return 'allowed'}catch(e){return e.name}finally{dest.remove()}})()`), 'InvalidStateError');
  assert.equal(await evaluate(`(()=>{src.style.width='9000px';try{ctx.drawImage(src,0,0);return 'allowed'}catch(e){return e.name}finally{src.style.width='40px'}})()`), 'InvalidStateError');
  // Render text through the ordinary painter as well as box decorations.
  await evaluate(`nested.remove();src.firstChild.remove();src.style.background='white';
    src.style.color='black';src.style.fontSize='18px';src.textContent='Hi';
    ctx.clearRect(0,0,80,60);ctx.drawImage(src,0,0)`);
  assert.equal(await evaluate(`[...ctx.getImageData(0,0,40,30).data].some((v,i)=>i%4===0&&v<100)`), true);
  await evaluate(`src.textContent='';globalThis.foreign=document.createElement('img');
    foreign.style.cssText='width:10px;height:10px';foreign.src='https://foreign.test/red.png';src.appendChild(foreign)`);
  for (let i=0;i<100 && !await evaluate('foreign.complete&&foreign.naturalWidth===2');i++) await Bun.sleep(10);
  assert.equal(await evaluate('foreign.naturalWidth'), 2);
  await evaluate('ctx.drawImage(src,0,0)');
  assert.deepEqual(await evaluate(`[()=>ctx.getImageData(0,0,1,1),()=>dest.toDataURL()].map(fn=>{try{fn();return 'allowed'}catch(e){return e.name}})`), ['SecurityError','SecurityError']);
  // A tainted nested canvas cannot launder the image through a DOM snapshot.
  await evaluate(`nested.getContext('2d').drawImage(foreign,0,0);foreign.remove();
    src.appendChild(nested);dest.width=80;ctx.drawImage(src,0,0)`);
  assert.equal(await evaluate(`(()=>{try{ctx.getImageData(0,0,1,1);return 'allowed'}catch(e){return e.name}})()`), 'SecurityError');
  await evaluate('dest.width=80;nested.remove();src.style.background="red"');
  // Oversized/rejected draws do not break the next successful capture.
  await evaluate('ctx.drawImage(src,0,0)');
  assert.deepEqual(await pixel(5,5), [255,0,0,255]);
  assert.equal(await evaluate(`(()=>{src.remove();try{ctx.drawImage(src,0,0);return 'allowed'}catch(e){return e.name}})()`), 'InvalidStateError');
  }
} finally { renderer.dispose(); }

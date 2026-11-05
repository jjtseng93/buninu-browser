import {strict as assert} from 'node:assert';
import {createPageRenderer, loadGraphics} from '../../lib/renderer/page-renderer.js';

const {CanvasKit} = await loadGraphics();
const traces = [];
const renderer = await createPageRenderer({onFrame() {}, trace: text => traces.push(text), reportError: error => { throw error; }});
const width = 640, height = 480;
async function pixels() {
  const image = CanvasKit.MakeImageFromEncoded(Buffer.from(await renderer.screenshot(), 'base64'));
  try {
    return image.readPixels(0, 0, {width: image.width(), height: image.height(),
      colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul,
      colorSpace: CanvasKit.ColorSpace.SRGB});
  } finally { image.delete(); }
}

try {
  renderer.setScripting('host');
  renderer.resize(width, height, 1);
  await renderer.loadDocument({url: 'https://shadow-damage.test/', contentType: 'text/html',
    source: '<!doctype html><body style="margin:0;background:white"><div id=clip><div id=box></div></div></body>'});
  await renderer.whenLoaded();
  const cases = [
    {name: 'wide blur tail', dpr: 1, shadow: '0 0 30px black'},
    {name: 'rounded fractional DPR', dpr: 1.5, shadow: '3px -4px 30px 5px #0009', style: 'border-radius:12px'},
    {name: 'nonuniform transform', dpr: 1, shadow: '0 0 30px black', style: 'transform:scale(.35,2);transform-origin:0 0'},
    {name: 'rotation and skew', dpr: .75, shadow: '2px 4px 25px black', style: 'transform:rotate(17deg) skewX(25deg);transform-origin:0 0'},
    {name: 'small blur at low DPR', dpr: .3, shadow: '0 0 1.7px black'},
    {name: 'ancestor rounded clip', dpr: 1.25, shadow: '0 0 30px black', clip: true},
    {name: 'opacity layer', dpr: 1.5, shadow: '0 0 30px black', style: 'opacity:.45'},
    {name: 'transformed shadow in rounded clip', dpr: .75, shadow: '2px 4px 25px black',
      style: 'transform:scale(.5,1.5);transform-origin:0 0', clip: true},
    {name: 'negative spread removes shape', dpr: 1, shadow: '0 0 10px -30px black'},
  ];
  for (const entry of cases) {
    const boxStyle = `position:absolute;left:100.3px;top:100.3px;width:30.3px;height:30.3px;background:red;box-shadow:${entry.shadow};${entry.style ?? ''}`;
    const clipStyle = entry.clip
      ? 'position:absolute;left:40px;top:30px;width:300px;height:250px;overflow:hidden;border-radius:20px'
      : '';
    await renderer.evaluate(`document.getElementById('box').style.cssText=${JSON.stringify(boxStyle)};document.getElementById('clip').style.cssText=${JSON.stringify(clipStyle)}`);
    renderer.resize(width + 1, height, entry.dpr);
    renderer.resize(width, height, entry.dpr);
    await pixels();
    for (const mutation of ["box.style.left='180.3px'", "box.style.boxShadow='none'"]) {
      // Removing an already empty shadow is correctly a no-op.
      if (entry.name === 'negative spread removes shape' && mutation.includes('none')) continue;
      traces.length = 0;
      await renderer.evaluate(`(() => {const box=document.getElementById('box');${mutation}})()`);
      const partial = await pixels();
      assert.ok(traces.some(text => text.includes('paint damage')),
        `${entry.name}: use real partial paint for ${mutation}`);
      renderer.resize(width + 1, height, entry.dpr);
      renderer.resize(width, height, entry.dpr);
      const full = await pixels();
      assert.equal(partial.length, full.length);
      let differingPixels = 0;
      for (let i = 0; i < full.length; i += 4) {
        if (partial[i] !== full[i] || partial[i + 1] !== full[i + 1]
          || partial[i + 2] !== full[i + 2] || partial[i + 3] !== full[i + 3]) differingPixels++;
      }
      assert.equal(differingPixels, 0, `${entry.name}: ${mutation} must match full repaint`);
    }
  }
} finally { renderer.dispose(); }

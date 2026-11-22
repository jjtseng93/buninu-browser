import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';

test('scrolling and mirroring a masked subtree moves its painted alpha with the content', async () => {
  const {CanvasKit} = await loadGraphics();
  const host = new RendererHost({timeout:20000});
  const width = 110, height = 70;
  async function sample(y) {
    const png = await host.call('screenshot', {format:'png'});
    const image = CanvasKit.MakeImageFromEncoded(Buffer.from(png, 'base64'));
    try {
      const bytes = image.readPixels(0, 0, {width, height, colorType:CanvasKit.ColorType.RGBA_8888,
        alphaType:CanvasKit.AlphaType.Unpremul, colorSpace:CanvasKit.ColorSpace.SRGB});
      return [5, 35].map(x => Array.from(bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)));
    } finally { image.delete(); }
  }
  try {
    await host.start();
    await host.call('resize', width, height, 1);
    await host.call('loadDocument', {url:'https://mask.test/', contentType:'text/html', source:`
      <body style="margin:0;background:white"><div id="scroller" style="width:80px;height:50px;overflow:auto">
      <div style="height:24px;background:blue"></div>
      <div id="mask" style="width:40px;height:20px;mask-image:linear-gradient(to right,transparent,black)">
      <div style="height:100%;background:red"></div></div><div style="height:70px;background:lime"></div></div>`});
    await host.call('whenLoaded');
    const before = await sample(30);
    expect(before[0][1]).toBeGreaterThan(200);
    expect(before[1][1]).toBeLessThan(50);
    expect(await sample(10)).toEqual([[0,0,255],[0,0,255]]);
    await host.call('evaluate', "document.getElementById('scroller').scrollTop=20");
    expect(await sample(10)).toEqual(before);
    await host.call('evaluate', "document.getElementById('mask').style.transform='scaleX(-1)'");
    const mirrored = await sample(10);
    expect(mirrored[0][1]).toBeLessThan(50);
    expect(mirrored[1][1]).toBeGreaterThan(200);
  } finally { await host.close(); }
});

test('repainting a fractional gradient mask preserves alpha as the content color changes', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('resize', 200, 100, 1);
    await host.call('loadDocument', {url:'https://mask.test/', contentType:'text/html', source:`
      <body style="background:white"><div id="masked" style="margin:4.5px;width:120px;height:39.5px;
        background:red;mask-image:linear-gradient(35deg, transparent, black 75%),
        linear-gradient(90deg, black, transparent)"></div></body>`});
    await host.call('whenLoaded');
    const snapshot = () => host.call('screenshot', {format:'png'});
    const red = await snapshot();
    await host.call('evaluate', 'document.getElementById("masked").style.background="blue"');
    const blue = await snapshot();
    expect(blue).not.toBe(red);
    for (const [color, expected] of [['red', red], ['blue', blue]]) {
      await host.call('evaluate', `document.getElementById("masked").style.background="${color}"`);
      expect(await snapshot()).toBe(expected);
    }
  } finally { await host.close(); }
});

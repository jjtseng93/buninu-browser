import {expect, test} from 'bun:test';
import {createPageRenderer, loadGraphics} from '../lib/renderer/page-renderer.js';

test('single-fill blur preserves the full-tile raster and never clips sibling fills', async () => {
  const {CanvasKit: kit} = await loadGraphics();
  const prototype = kit.ImageFilter.prototype;
  const outputBounds = prototype.getOutputBounds;
  const renderer = await createPageRenderer({});
  let bounded = false, calls = 0;
  prototype.getOutputBounds = function (...args) {
    calls++;
    return bounded ? outputBounds.apply(this, args) : [0, 0, 10000, 10000];
  };
  async function pixels(scale, sigma, children = '') {
    renderer.resize(360, 210, scale);
    calls = 0;
    await renderer.loadDocument({url:'https://blur.test/', contentType:'text/html', source:`<style>
      body{margin:0;background:#fed}section{position:absolute;left:31.5px;top:17px;width:180px;height:110px;overflow:hidden}
      i{display:block;position:absolute;top:11.75px;left:22.7px;width:45.4px;height:38.9px;background:#2589;border-radius:17px;filter:blur(${sigma}px)}
      b{display:block;position:absolute;left:75px;top:5px;width:20px;height:20px;background:red}
      </style><section><i>${children}</i></section>`});
    await renderer.whenLoaded();
    return (await renderer.screenshot({format:'rgba'})).pixels;
  }
  try {
    for (const [scale, sigma] of [[1,10], [1.25,10], [2,4.25], [2,17]]) {
      bounded = false;
      const reference = await pixels(scale, sigma);
      bounded = true;
      const actual = await pixels(scale, sigma);
      expect(calls).toBeGreaterThan(0);
      expect(Bun.deepEquals(actual, reference)).toBe(true);
    }
    await pixels(1, 10, '<b></b>');
    expect(calls).toBe(0);
  } finally {
    prototype.getOutputBounds = outputBounds;
    renderer.dispose();
  }
});

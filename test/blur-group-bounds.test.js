import {expect, test} from 'bun:test';
import {createPageRenderer, loadGraphics} from '../lib/renderer/page-renderer.js';

test('single-fill blur and clipped SVG shadows preserve the full-tile raster', async () => {
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

    async function clippedShadow() {
      await renderer.loadDocument({url:'https://shadow.test/', contentType:'text/html', source:
        '<section style="overflow:hidden;width:92px;height:71px"><div style="filter:drop-shadow(-3px 4px 3px #0008);overflow:hidden;width:48px;height:45px"><svg width="60" height="48"><circle cx="38" cy="23" r="21" fill="red"/></svg></div></section>'});
      await renderer.whenLoaded();
      return (await renderer.screenshot({format:'rgba'})).pixels;
    }
    bounded = false;
    const shadowReference = await clippedShadow();
    bounded = true;
    calls = 0;
    expect(Bun.deepEquals(await clippedShadow(), shadowReference)).toBe(true);
    expect(calls).toBeGreaterThan(0);
  } finally {
    prototype.getOutputBounds = outputBounds;
    renderer.dispose();
  }
});

test('pointwise layer clips include overflow from every sibling at fractional DPR', async () => {
  const {CanvasKit: kit} = await loadGraphics();
  const renderer = await createPageRenderer({});
  const makeRect = kit.LTRBRect;
  let bounded = true, calls = 0;
  kit.LTRBRect = function (left, top, right, bottom) {
    if (left === 0 && top === 0 && right > 0 && right < 200 && bottom > 0 && bottom < 100) {
      calls++;
      if (!bounded) return makeRect(0, 0, 10000, 10000);
    }
    return makeRect(left, top, right, bottom);
  };
  async function pixels(effect) {
    await renderer.loadDocument({url:'https://effects.test/', contentType:'text/html', source:
      '<style>body{margin:0;background:#eed}section{position:absolute;left:12.5px;top:9px;width:30px;height:16px;background:red;' +
      effect + '}i{position:absolute;left:65.5px;top:26px;width:14px;height:12px;background:blue}</style><section><i></i></section>'});
    await renderer.whenLoaded();
    return (await renderer.screenshot({format:'rgba'})).pixels;
  }
  try {
    renderer.resize(240, 140, 1.5);
    for (const effect of ['mix-blend-mode:multiply', 'filter:contrast(.8) invert(.25)',
      'mask-image:linear-gradient(90deg,black,transparent)']) {
      bounded = false;
      const reference = await pixels(effect);
      calls = 0;
      bounded = true;
      const actual = await pixels(effect);
      expect(calls).toBeGreaterThan(0);
      expect(Bun.deepEquals(actual, reference)).toBe(true);
    }
  } finally {
    kit.LTRBRect = makeRect;
    renderer.dispose();
  }
});

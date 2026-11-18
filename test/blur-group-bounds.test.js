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

test('a repeated clipped fill reuses its blur while new colors start cold', async () => {
  const events = [];
  const renderer = await createPageRenderer({trace(message) {
    if (message.startsWith('blur cache')) events.push(message);
  }});
  async function frame(color, background) {
    events.length = 0;
    await renderer.loadDocument({url:'https://blur.test/', contentType:'text/html', source:`<style>
      body{background:${background}}section{width:110px;height:60px;overflow:hidden;border-radius:8px}
      i{display:block;margin-left:-5px;width:85px;height:45px;background:${color};border-radius:12px;filter:blur(5px)}
      </style><section><i></i></section>`});
    await renderer.whenLoaded();
    return (await renderer.screenshot({format:'rgba'})).pixels;
  }
  try {
    renderer.resize(210, 120, 1.5);
    const cold = await frame('#579a', '#dea');
    expect(events).toEqual([]);
    await frame('#579a', '#333');
    expect(events).toContain('blur cache miss');
    const warm = await frame('#579a', '#dea');
    expect(events).toContain('blur cache hit');
    expect(Bun.deepEquals(warm, cold)).toBe(true);
    const changed = await frame('#923a', '#dea');
    expect(events).toEqual([]);
    expect(Bun.deepEquals(changed, cold)).toBe(false);
  } finally { renderer.dispose(); }
});

test('off-origin shadows match layers anchored at the viewport origin', async () => {
  const {CanvasKit: kit} = await loadGraphics();
  const renderer = await createPageRenderer({});
  const makeRect = kit.LTRBRect;
  let reference = false, clips = 0;
  kit.LTRBRect = (l,t,r,b) => {
    if (l > 0 && t > 0 && l % 64 === 0 && t % 64 === 0) {
      clips++;
      if (reference) return makeRect(0,0,r,b);
    }
    return makeRect(l,t,r,b);
  };
  try {
    for (const scale of [1,1.25,2]) {
      renderer.resize(600,350,scale);
      const source = `<style>body{margin:0;background:#eca}section{position:absolute;left:327.4px;top:175.8px;
        width:83px;height:95px;overflow:hidden}i,svg{filter:drop-shadow(-2.5px 4.5px 1px #0009)}
        i{display:block;width:67.5px;height:5.7px;background:red}
        p{margin:0;mask-image:linear-gradient(90deg,#000,transparent)}</style>
        <section><i></i><svg width="70" height="50"><circle cx="36" cy="23" r="24"/></svg><p>masked text</p></section>`;
      const frames=[];
      for (reference of [true,false]) {
        clips=0;
        await renderer.loadDocument({url:'https://shadow.test/',contentType:'text/html',source});
        await renderer.whenLoaded();
        frames.push((await renderer.screenshot({format:'rgba'})).pixels);
        expect(clips).toBeGreaterThan(0);
      }
      expect(Bun.deepEquals(frames[0],frames[1])).toBe(true);
    }
  } finally { kit.LTRBRect=makeRect; renderer.dispose(); }
});

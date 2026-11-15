// Geometry of empty inline elements, vertical-align shifts, ex and absolute units, MathMLElement's
// inline style and SVG text: what MathJax's lazy typesetting (IntersectionObserver on empty
// <mjx-container> elements, MathML token styles, ex-sized SVG with overflow: visible) and
// diagram SVG (text labels) rely on.
import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';
import { RenderTreeBuilder } from '../lib/render-tree/index.js';
import { layoutText } from '../lib/layout/text-layout.js';
import { elementBounds } from '../lib/input/hit-test.js';
import { extractSvg, svgLength } from '../lib/render-tree/svg.js';
import { RendererHost } from '../lib/renderer/host.js';

test('dynamic accessibility MathML stays unpainted after style changes and scrolling', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('resize', 400, 300, 1);
    await host.call('loadDocument', { url: 'https://math-effects.test/', contentType: 'text/html', source: `<!doctype html>
      <style>body {margin:0;background:white} #space {height:2000px} #copy {position:fixed;top:40px;left:20px}</style>
      <div id="space"></div><span id="copy"></span>` });
    await host.call('whenLoaded');
    const baseline = await host.call('screenshot');
    await host.call('evaluate', `document.getElementById('copy').innerHTML = '<math><mfrac><mi>x</mi><mn>2</mn></mfrac></math>'`);
    expect(await host.call('screenshot')).not.toBe(baseline);
    for (const css of ['opacity:0', 'opacity:0;width:1px;height:1px;overflow:hidden', 'visibility:hidden']) {
      await host.call('evaluate', `document.getElementById('copy').style.cssText = ${JSON.stringify('position:fixed;top:40px;left:20px;')} + ${JSON.stringify(css)}`);
      expect(await host.call('screenshot')).toBe(baseline);
      await host.call('scroll', 0, 250);
      expect(await host.call('screenshot')).toBe(baseline);
    }
  } finally { await host.stop?.(); }
}, 60000);

function laidOut(html, width = 400) {
  const { window, document } = parseHTMLDocument(`<!doctype html><body style="margin:0;font:16px sans-serif">${html}`);
  const styles = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, styles);
  const layout = layoutText(tree, { width, height: 600, x: 0, y: 0 });
  const runsOf = (id) => layout.fragments.flatMap((fragment) => fragment.runs)
    .filter((run) => tree.nodesById.get(run.nodeId)?.domNode?.parentElement?.id === id);
  return { window, document, styles, tree, layout, runsOf,
    bounds: (id) => elementBounds(tree, layout, document.getElementById(id)),
    close: () => window.happyDOM.close() };
}

test('an empty inline element has a zero-width place in its line, or at its block when alone', () => {
  const page = laidOut(`<p style="margin:0">before <x-box id=a><x-lazy id=b></x-lazy></x-box> after <span id=c></span>
    end</p><p style="margin:20px 0" id=only><span style="display:none">hidden</span><x-box id=d></x-box></p><p id=after>after</p>`);
  try {
    for (const id of ['a', 'b', 'c']) {
      const rect = page.bounds(id);
      expect(rect.width).toBe(0);
      expect(rect.left).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
    expect(page.bounds('a').left).toBe(page.bounds('b').left);
    expect(page.bounds('c').left).toBeGreaterThan(page.bounds('a').left);
    // Alone in its block it sits at the block's start, and takes no height.
    expect(page.bounds('d')).toMatchObject({ left: 0, width: 0, height: 0 });
  } finally { page.close(); }
});

test('a block holding only empty inlines still collapses margins as before', () => {
  const plain = laidOut(`<p style="margin:20px 0"></p><p id=after style="margin:20px 0">after</p>`);
  const anchored = laidOut(`<p style="margin:20px 0"><x-box></x-box></p><p id=after style="margin:20px 0">after</p>`);
  try { expect(anchored.bounds('after').top).toBe(plain.bounds('after').top); }
  finally { plain.close(); anchored.close(); }
});

test('vertical-align: sub and super shift from the parent font; lengths and percentages raise', () => {
  const page = laidOut(`<p style="margin:0;line-height:20px"><span id=base>x</span><sup id=sup>2</sup><sub id=sub>i</sub>
    <span id=up style="vertical-align:10px">u</span><span id=down style="vertical-align:-0.5em">d</span>
    <span id=pct style="vertical-align:50%;line-height:20px">p</span></p>`);
  try {
    const top = (id) => page.runsOf(id)[0].y;
    const base = top('base');
    expect(page.styles.get(page.document.getElementById('sup')).verticalAlign).toBe('super');
    expect(page.styles.get(page.document.getElementById('sup')).fontSize).toBeCloseTo(16 / 1.2, 5);
    // Blink's shifts: super by font-size/3 + 1, sub by font-size/5 + 1, from the parent's 16px.
    expect(top('sup')).toBeLessThan(base);
    expect(top('sub')).toBeGreaterThan(base);
    expect(page.styles.get(page.document.getElementById('down')).verticalAlign).toBe(-8);
    expect(page.styles.get(page.document.getElementById('pct')).verticalAlign).toBe(10);
    expect(top('up')).toBeCloseTo(base - 10, 5);
    expect(top('down')).toBeCloseTo(base + 8, 5);
    expect(top('pct')).toBeCloseTo(base - 10, 5);
  } finally { page.close(); }
});

test('ex is half an em without a measured x-height, and absolute units convert at 96px per inch', () => {
  const page = laidOut(`<div id=ex style="width:4ex;height:1in;font-size:20px"></div><div id=cm style="width:2.54cm;height:72pt"></div>`);
  try {
    const style = (id) => page.styles.get(page.document.getElementById(id));
    expect(style('ex').width).toBe(40);
    expect(style('ex').height).toBe(96);
    expect(style('cm').width).toBeCloseTo(96, 5);
    expect(style('cm').height).toBeCloseTo(96, 5);
  } finally { page.close(); }
});

test('svg width and height attributes take ex, em and absolute units; overflow decides clipping', () => {
  expect(svgLength('2ex', 20)).toBe(20);
  expect(svgLength('1.5em', 20)).toBe(30);
  expect(svgLength('72pt')).toBe(96);
  expect(svgLength('12')).toBe(12);
  expect(svgLength('50%')).toBeNull();
  const page = laidOut(`<svg id=s width="10ex" height="2ex" viewBox="0 0 100 20" style="font-size:20px"></svg>
    <svg id=v width="10" height="10" style="overflow:visible"></svg><svg id=h width="10" height="10"></svg>`);
  try {
    const node = (id) => [...page.tree.nodesById.values()].find((entry) => entry.domNode?.id === id);
    expect(node('s')).toMatchObject({ widthAttribute: 100, heightAttribute: 20 });
    expect(node('h').svg.clip).toBe(true);
    expect(node('v').svg.clip).toBe(false);
  } finally { page.close(); }
});

test('svg text becomes text runs with inherited fonts, anchors, baselines and tspan offsets', () => {
  const { window, document } = parseHTMLDocument(`<!doctype html><svg id=s viewBox="0 0 200 100" font-family="serif" font-size="10">
    <g fill="#ff0000" font-weight="bold"><text x="100" y="20" text-anchor="middle" dominant-baseline="central">中文 😀</text></g>
    <text x="5" y="50" font-size="200%">first<tspan x="5" dy="12" fill="#00ff00">second</tspan><tspan dx="3">  third  </tspan></text>
    <text x="1" y="1" fill="none">invisible</text></svg>`);
  try {
    const styles = new StyleEngine().compute(document);
    const svg = extractSvg(document.getElementById('s'), 'rgba(0, 0, 0, 1)', styles);
    const texts = svg.shapes.filter((shape) => shape.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0].runs[0]).toMatchObject({ text: '中文 😀', x: 100, y: 20, anchor: 'middle', baseline: 'central',
      fontSize: 10, fontWeight: 700, fill: 'rgba(255, 0, 0, 1)' });
    expect(texts[0].runs[0].fontFamily).toEqual(['serif']);
    expect(texts[1].runs.map((run) => [run.text, run.x, run.dx, run.dy, run.fontSize])).toEqual([
      ['first', 5, 0, 0, 20], ['second', 5, 0, 12, 20], [' third', null, 3, 0, 20]]);
    expect(texts[1].runs[1].fill).toBe('rgba(0, 255, 0, 1)');
  } finally { window.happyDOM.close(); }
});

test('MathML elements have MathMLElement inline style, and observers see empty inline elements', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('resize', 500, 400, 1);
    await host.call('loadDocument', { url: 'https://inline-geometry.test/', contentType: 'text/html', source: `<!doctype html>
      <body style="margin:0;font:16px sans-serif"><p style="margin-top:100px">before <x-box id=a><x-lazy></x-lazy></x-box> after</p>
      <p><span style="display:none">hidden</span><x-box id=b></x-box></p>
      <math><mtable><mtr><mtd id=cell style="padding-bottom: 3px">x</mtd></mtr></mtable></math></body>` });
    await host.call('whenLoaded');
    const evaluate = (source) => host.call('evaluate', source);
    expect(await evaluate(`(() => { const cell = document.getElementById('cell'); cell.style.removeProperty('padding-bottom');
      return [cell instanceof MathMLElement, cell instanceof Element, Object.getPrototypeOf(cell) === MathMLElement.prototype,
        cell.getAttribute('style') ?? '', typeof cell.dataset, typeof cell.focus, 'onclick' in cell]; })()`))
      .toEqual([true, true, true, '', 'object', 'function', true]);
    expect(await evaluate(`(() => { const r = document.getElementById('a').getBoundingClientRect(); return [r.width, r.top > 90, r.left > 0]; })()`))
      .toEqual([0, true, true]);
    expect(await evaluate(`new Promise((resolve) => { const seen = {};
      const observer = new IntersectionObserver((entries) => { for (const entry of entries) seen[entry.target.id] = [entry.isIntersecting, entry.intersectionRatio];
        if (seen.a && seen.b) { observer.disconnect(); resolve(seen); } });
      observer.observe(document.getElementById('a')); observer.observe(document.getElementById('b')); })`))
      .toEqual({ a: [true, 1], b: [true, 1] });
  } finally { await host.stop?.(); }
}, 60000);

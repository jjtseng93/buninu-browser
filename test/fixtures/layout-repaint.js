import assert from 'node:assert/strict';
import { createPageRenderer, loadGraphics } from '../../lib/renderer/page-renderer.js';
import { LayoutEngine } from '../../lib/layout/text-layout.js';

const original = LayoutEngine.prototype.layout;
let layouts = 0;
LayoutEngine.prototype.layout = function(...args) { layouts++; return original.apply(this, args); };
const renderer = await createPageRenderer({});
const { CanvasKit: kit } = await loadGraphics();
const geometry = `Array.from(document.querySelectorAll('[data-check]'), e => {
  const r=e.getBoundingClientRect(); return [e.id,r.x,r.y,r.width,r.height];
})`;
const pixels = async () => {
  const encoded = await renderer.screenshot();
  const image = kit.MakeImageFromEncoded(Buffer.from(encoded, 'base64'));
  try {
    return image.readPixels(0, 0, { width: 320, height: 240, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
  } finally { image.delete(); }
};

try {
  renderer.setScripting('host');
  renderer.resize(320, 240, 1);
  await renderer.loadDocument({ url: 'https://repaint.test/', contentType: 'text/html', status: 200,
    source: `<!doctype html><style>
      body { margin:0; background:white; color:#123 }
      #box { position:relative; z-index:2; width:140px; height:76px; overflow:hidden }
      #nested { opacity:.5; background:#ffd; border:1px solid currentColor }
      #behind { position:absolute; z-index:-1; left:5px; top:5px; background:#58a }
      #above { position:absolute; z-index:3; left:30px; top:25px; background:#f80 }
      #gradient { width:160px; background-image:linear-gradient(red,blue); background-clip:text; font-size:22px }
      #wrap { width:100px } #decorated { background:#eee }
      td { padding:3%; border:1px solid currentColor }
    </style><div id="box" data-check>text <span id="nested" data-check>nested</span>
      <span id="behind" data-check>behind</span><span id="above" data-check>above</span></div>
    <div id="gradient" data-check>Gradient text</div>
    <div id="wrap" data-check><span id="decorated" data-check>several wrapped words</span> <span id="plain" data-check>plain</span></div>
    <table style="width:180px"><tr><td id="cell" data-check>table</td><td>other</td></tr></table>` });
  await renderer.whenLoaded();
  await pixels();

  for (const [id, property, value, expectedLayouts] of [
    ['box', 'opacity', '.45', 0], ['box', 'opacity', '0', 0], ['box', 'opacity', '1', 0],
    ['box', 'backgroundColor', '#ade', 0], ['decorated', 'backgroundColor', '#fea', 0],
    ['cell', 'backgroundColor', '#def', 0], ['gradient', 'opacity', '.6', 0],
    ['gradient', 'backgroundSize', '40px 20px', 0],
    ['plain', 'backgroundColor', '#fbc', 1], ['plain', 'backgroundColor', 'transparent', 1],
    ['box', 'color', '#a30', 1], ['box', 'width', '150px', 1],
  ]) {
    const before = layouts;
    const retainedGeometry = await renderer.evaluate(`(() => {
      document.getElementById(${JSON.stringify(id)}).style[${JSON.stringify(property)}]=${JSON.stringify(value)};
      return ${geometry};
    })()`);
    const label = `${id}.${property}=${value}`;
    assert.equal(layouts - before, expectedLayouts, `${label}: layout calls while reading geometry`);
    const retainedPixels = await pixels();
    // Viewport invalidation forces a complete style/layout pass. Restore the
    // original viewport before comparing every measured rect and raster pixel.
    renderer.resize(321, 240, 1);
    renderer.resize(320, 240, 1);
    assert.deepEqual(await renderer.evaluate(geometry), retainedGeometry, `${label}: geometry`);
    assert.deepEqual(await pixels(), retainedPixels, `${label}: pixels`);
  }
} finally {
  renderer.dispose();
  LayoutEngine.prototype.layout = original;
}

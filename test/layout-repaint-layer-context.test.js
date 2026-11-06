import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';
import { RenderTreeBuilder } from '../lib/render-tree/index.js';
import { LayoutEngine } from '../lib/layout/text-layout.js';
import { buildDisplayList, hitTarget } from '../lib/paint/display-list.js';
import { interactiveRegions } from '../lib/input/hit-test.js';
import { repaintLayout } from '../lib/layout/repaint.js';

function fixture(content) {
  const parsed = parseHTMLDocument(`<body style="margin:0">${content}<p>outside</p></body>`);
  const builder = new RenderTreeBuilder(), options = { width: 400, viewportHeight: 300 };
  const build = () => builder.build(parsed.document, new StyleEngine().compute(parsed.document));
  const first = build(), layout = new LayoutEngine().layout(first, options);
  return { ...parsed, build, first, layout, options, target: parsed.document.getElementById('target') };
}

function layerFor(layout, tree, element) {
  const id = [...tree.nodesById.values()].find(node => node.domNode === element)?.id;
  return layout.boxes.find(box => box.nodeId === id && !box.inline)?.layer;
}

function expectEquivalent(f, tree, retained) {
  expect(retained).not.toBeNull();
  const full = new LayoutEngine().layout(tree, f.options);
  // Fragment creation generation intentionally remains the old generation.
  const comparable = layout => ({ ...layout, fragments: layout.fragments.map(({ id, ...fragment }) => fragment) });
  expect(comparable(retained)).toEqual(comparable(full));
  const painted = buildDisplayList(retained, tree), reference = buildDisplayList(full, tree);
  expect(painted).toEqual(reference);
  expect(painted.hits).toEqual(reference.hits);
  expect(painted.scrollers).toEqual(reference.scrollers);
  expect(painted.extent).toEqual(reference.extent);
  expect(interactiveRegions(tree, retained)).toEqual(interactiveRegions(tree, full));
  for (const hit of reference.hits) {
    const x = hit.rect.x + hit.rect.width / 2, y = hit.rect.y + hit.rect.height / 2;
    expect(hitTarget(painted, x, y, { x: 0, y: 0 })).toBe(hitTarget(reference, x, y, { x: 0, y: 0 }));
  }
  return painted;
}

const descendants = `<p style="margin:0;background:yellow">ordinary text</p>
  <div style="position:relative;background:green">auto layer
    <a href="#" style="position:absolute;z-index:4;top:0;left:15px;background:white">above</a>
  </div>
  <div style="position:absolute;z-index:-1;top:2px;left:3px;background:blue">behind</div>
  <div style="opacity:.7;background:orange">nested context
    <div style="position:relative;z-index:2;background:pink">nested child</div>
  </div>`;

for (const position of ['relative', 'absolute']) {
  test(`${position} opacity contexts retain geometry and rebuild descendant stacking order`, () => {
    const f = fixture(`<div style="position:relative;z-index:2;height:180px;background:gray">
      <div id="target" style="position:${position};opacity:.5;top:5px;left:5px;width:160px;height:120px;background:red">${descendants}</div>
      <div style="position:absolute;z-index:1;top:10px;left:10px;background:cyan">overlapping sibling</div>
      </div>`);
    try {
      let previous = f.first, layout = f.layout;
      for (const opacity of ['1', '0.4', '0', '1']) {
        const before = JSON.stringify(layout), previousLayer = layerFor(layout, previous, f.target);
        f.target.style.opacity = opacity;
        const next = f.build(), retained = repaintLayout(layout, previous, next);
        expectEquivalent(f, next, retained);
        expect(layerFor(retained, next, f.target).context).toBe(Number(opacity) < 1);
        expect(layerFor(retained, next, f.target).order).toBe(previousLayer.order);
        expect(JSON.stringify(layout)).toBe(before);
        const outside = layout.fragments.findIndex(fragment => fragment.runs.some(run => run.text === 'outside'));
        expect(outside).toBeGreaterThanOrEqual(0);
        expect(retained.fragments[outside]).toBe(layout.fragments[outside]);
        previous = next;
        layout = retained;
      }
    } finally { f.window.happyDOM.abort(); }
  });
}

test('simultaneous nested opacity transitions reparent layers to their nearest surviving context', () => {
  const f = fixture(`<div id="target" style="position:relative;opacity:.5;background:red">
    <div id="inner" style="position:relative;opacity:.4;background:blue">${descendants}</div>
    <div style="position:relative;z-index:1;background:cyan">sibling</div>
    </div>`);
  try {
    let previous = f.first, layout = f.layout;
    const inner = f.document.getElementById('inner');
    for (const [outerOpacity, innerOpacity] of [['1', '1'], ['.7', '.6'], ['1', '.6'], ['.7', '1']]) {
      f.target.style.opacity = outerOpacity;
      inner.style.opacity = innerOpacity;
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      expectEquivalent(f, next, retained);
      const outerLayer = layerFor(retained, next, f.target), innerLayer = layerFor(retained, next, inner);
      expect(innerLayer.parent).toBe(outerLayer.context ? outerLayer : outerLayer.parent);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

test('a deferred fixed descendant keeps its DOM stacking ancestry when an absolute popup fades', () => {
  const f = fixture(`<div style="position:relative;height:180px">
    <div id="target" style="position:absolute;top:15px;left:10px;opacity:.5;background:red">
      popup <div style="position:fixed;z-index:5;top:10px;left:20px;background:blue">fixed descendant</div>
    </div><div style="position:absolute;z-index:1;top:10px;left:20px;background:green">sibling</div></div>`);
  try {
    f.target.style.opacity = '1';
    const next = f.build();
    expectEquivalent(f, next, repaintLayout(f.layout, f.first, next));
  } finally { f.window.happyDOM.abort(); }
});

for (const display of ['flex', 'grid']) {
  test(`a positioned block ${display} item safely retains its layer across opacity 1`, () => {
    const f = fixture(`<div style="display:${display};grid-template-columns:200px 100px">
      <div id="target" style="position:relative;width:200px;opacity:.5;background:red">${descendants}</div>
      <div style="position:relative;z-index:1;background:blue">sibling</div></div>`);
    try {
      f.target.style.opacity = '1';
      const next = f.build();
      expectEquivalent(f, next, repaintLayout(f.layout, f.first, next));
    } finally { f.window.happyDOM.abort(); }
  });

  test(`an inline ${display} item's blockified transform context falls back rather than being removed`, () => {
    const f = fixture(`<div style="display:${display}">
      <span id="target" style="position:relative;transform:translateX(0px);opacity:.5;background:red">
        transformed <span style="position:absolute;z-index:2;background:blue">child</span>
      </span><div style="position:relative;z-index:1;background:green">sibling</div></div>`);
    try {
      expect(layerFor(f.layout, f.first, f.target).context).toBe(true);
      f.target.style.opacity = '1';
      const next = f.build(), full = new LayoutEngine().layout(next, f.options);
      expect(layerFor(full, next, f.target).context).toBe(true);
      expect(repaintLayout(f.layout, f.first, next)).toBeNull();
    } finally { f.window.happyDOM.abort(); }
  });
}

test('unpositioned opacity context removal still requires layout to remove the layer', () => {
  const f = fixture(`<div id="target" style="opacity:.5;background:red">${descendants}</div>`);
  try {
    f.target.style.opacity = '1';
    expect(repaintLayout(f.layout, f.first, f.build())).toBeNull();
  } finally { f.window.happyDOM.abort(); }
});

test('the root ignores CSS positioning and cannot retain a layer created only by opacity', () => {
  const f = fixture('<div>root contents</div>');
  try {
    f.document.body.style.position = 'relative';
    f.document.body.style.opacity = '.5';
    const previous = f.build(), layout = new LayoutEngine().layout(previous, f.options);
    f.document.body.style.opacity = '1';
    const next = f.build();
    expect(repaintLayout(layout, previous, next)).toBeNull();
  } finally { f.window.happyDOM.abort(); }
});

for (const [property, value] of [['position', 'static'], ['zIndex', '2'], ['transform', 'translateX(1px)']]) {
  test(`opacity transitions cannot admit simultaneous ${property} geometry or layer changes`, () => {
    const f = fixture(`<div id="target" style="position:relative;opacity:.5;background:red">${descendants}</div>`);
    try {
      f.target.style.opacity = '1';
      f.target.style[property] = value;
      expect(repaintLayout(f.layout, f.first, f.build())).toBeNull();
    } finally { f.window.happyDOM.abort(); }
  });
}

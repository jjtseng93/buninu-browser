import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';
import { RenderTreeBuilder, sameLayoutInput } from '../lib/render-tree/index.js';
import { LayoutEngine } from '../lib/layout/text-layout.js';
import { buildDisplayList } from '../lib/paint/display-list.js';
import { repaintLayout } from '../lib/layout/repaint.js';

function fixture(display = 'inline', extraStyle = '', parentStyle = '') {
  const parsed = parseHTMLDocument(`<body><div style="width:260px;${parentStyle}">before
    <svg id="icon" width="40" height="40" viewBox="0 0 20 20" style="display:${display};${extraStyle}">
      <path d="M2 2H18V18H2Z" fill="red"/>
    </svg> after</div><p>outside</p></body>`);
  const builder = new RenderTreeBuilder(), options = { width: 300, viewportHeight: 200 };
  const build = () => builder.build(parsed.document, new StyleEngine().compute(parsed.document));
  const first = build(), layout = new LayoutEngine().layout(first, options);
  const svg = parsed.document.getElementById('icon');
  const nodeId = [...first.nodesById.values()].find(node => node.domNode === svg).id;
  return { ...parsed, build, first, layout, options, svg, nodeId };
}

function expectEquivalent(f, tree, retained) {
  expect(retained).not.toBeNull();
  const full = new LayoutEngine().layout(tree, f.options);
  // Retained fragment IDs intentionally keep their original generation.
  const comparable = layout => ({ ...layout, fragments: layout.fragments.map(({ id, ...fragment }) => fragment) });
  expect(comparable(retained)).toEqual(comparable(full));
  const painted = buildDisplayList(retained, tree), reference = buildDisplayList(full, tree);
  expect(painted).toEqual(reference);
  expect(painted.hits).toEqual(reference.hits);
  expect(painted.scrollers).toEqual(reference.scrollers);
  expect(painted.extent).toEqual(reference.extent);
  return painted;
}

function imageRun(layout, id) {
  return layout.fragments.flatMap(fragment => fragment.runs).find(run => run.nodeId === id && run.type === 'image');
}

for (const display of ['inline', 'block']) {
  test(`${display} SVG shape paint retains geometry and matches a full layout`, () => {
    const f = fixture(display);
    try {
      const before = JSON.stringify(f.layout), oldRun = imageRun(f.layout, f.nodeId);
      const path = f.svg.querySelector('path');
      path.setAttribute('fill', 'blue');
      path.setAttribute('d', 'M0 0L20 10L0 20Z');
      path.setAttribute('transform', 'translate(2 1) rotate(10)');
      path.setAttribute('stroke', 'green');
      path.setAttribute('stroke-width', '3');
      const next = f.build();
      expect(sameLayoutInput(f.first.root, next.root, { ignoreStyles: true })).toBe(false);
      const retained = repaintLayout(f.layout, f.first, next);
      const painted = expectEquivalent(f, next, retained);
      const updated = imageRun(retained, f.nodeId);
      expect(updated).not.toBe(oldRun);
      expect(updated.svg).toBe(next.nodesById.get(f.nodeId).svg);
      expect(updated.svg).not.toBe(oldRun.svg);
      expect(Object.isFrozen(updated)).toBe(true);
      expect(painted.items.some(item => item.op === 'drawSvg' && item.svg === updated.svg)).toBe(true);
      expect(JSON.stringify(f.layout)).toBe(before);
      expect(retained.boxes).toBe(f.layout.boxes);
      const outside = f.layout.fragments.findIndex(fragment => fragment.runs.some(run => run.text === 'outside'));
      expect(outside).toBeGreaterThanOrEqual(0);
      expect(retained.fragments[outside]).toBe(f.layout.fragments[outside]);
      expect(retained.fragments[outside].runs).toBe(f.layout.fragments[outside].runs);
    } finally { f.window.happyDOM.abort(); }
  });
}

test('removing and restoring all SVG shapes updates paint without losing its replaced box', () => {
  const f = fixture();
  try {
    const path = f.svg.querySelector('path');
    let previous = f.first, layout = f.layout;
    for (const visible of [false, true, false]) {
      if (visible) f.svg.appendChild(path);
      else path.remove();
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      const painted = expectEquivalent(f, next, retained);
      expect(painted.items.some(item => item.op === 'drawSvg' && item.nodeId === f.nodeId)).toBe(visible);
      expect(imageRun(retained, f.nodeId)).toMatchObject({ width: 40, height: 40 });
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

test('same-ratio SVG viewBox and preserveAspectRatio changes only replace paint', () => {
  const f = fixture();
  try {
    let previous = f.first, layout = f.layout;
    for (const [attribute, value] of [['viewBox', '10 10 40 40'], ['preserveAspectRatio', 'none'], ['preserveAspectRatio', 'xMaxYMin slice']]) {
      f.svg.setAttribute(attribute, value);
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      expectEquivalent(f, next, retained);
      expect(imageRun(retained, f.nodeId).svg).toBe(next.nodesById.get(f.nodeId).svg);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

for (const [attribute, value] of [['width', '50'], ['height', '50'], ['viewBox', '0 0 40 20'], ['style', 'width:50px']]) {
  test(`SVG ${attribute} changing intrinsic or CSS geometry still requires layout`, () => {
    const f = fixture();
    try {
      f.svg.setAttribute(attribute, value);
      expect(repaintLayout(f.layout, f.first, f.build())).toBeNull();
    } finally { f.window.happyDOM.abort(); }
  });
}

test('SVG payload and paint-only style changes update the same retained run together', () => {
  const f = fixture('block', 'opacity:.8;background:red');
  try {
    f.svg.style.opacity = '.5';
    f.svg.style.backgroundColor = 'blue';
    f.svg.querySelector('path').setAttribute('fill', 'green');
    const next = f.build(), retained = repaintLayout(f.layout, f.first, next);
    expectEquivalent(f, next, retained);
    expect(imageRun(retained, f.nodeId).style).toMatchObject({ opacity: .5, backgroundColor: 'rgba(0, 0, 255, 1)' });
    expect(imageRun(retained, f.nodeId).svg).toBe(next.nodesById.get(f.nodeId).svg);
  } finally { f.window.happyDOM.abort(); }
});

test('ignoring SVG paint is limited to existing SVG replaced elements and checks ratio independently', () => {
  const f = fixture();
  try {
    const previous = f.first.nodesById.get(f.nodeId);
    f.svg.querySelector('path').setAttribute('fill', 'blue');
    const next = f.build().nodesById.get(f.nodeId);
    const options = { ignoreStyles: true, ignoreSvgPaint: true };
    expect(sameLayoutInput(previous, next, { ignoreStyles: true })).toBe(false);
    expect(sameLayoutInput(previous, next, options)).toBe(true);
    expect(sameLayoutInput({ ...previous, tagName: 'IMG' }, { ...next, tagName: 'IMG' }, options)).toBe(false);
    expect(sameLayoutInput({ ...previous, type: 'block' }, { ...next, type: 'block' }, options)).toBe(false);
    expect(sameLayoutInput(previous, { ...next, svg: null }, options)).toBe(false);
    expect(sameLayoutInput(previous, { ...previous, svgRatio: 2 }, options)).toBe(false);
    expect(sameLayoutInput(previous, { ...previous, svgRatio: 2 })).toBe(false);
  } finally { f.window.happyDOM.abort(); }
});

for (const display of ['inline', 'block']) {
  for (const initial of ['visible', 'hidden']) {
    test(`${display} SVG visibility from ${initial} updates retained paint and hit testing`, () => {
      const f = fixture(display, `visibility:${initial}`);
      try {
        let previous = f.first, layout = f.layout;
        const values = initial === 'visible' ? ['hidden', 'visible', 'hidden'] : ['visible', 'hidden', 'visible'];
        for (const visibility of values) {
          const before = JSON.stringify(layout);
          f.svg.style.visibility = visibility;
          // Hidden shapes must not leave a stale empty/visible SVG payload
          // when the same retained run is shown or hidden again.
          f.svg.querySelector('path').setAttribute('fill', visibility === 'visible' ? 'blue' : 'green');
          const next = f.build(), retained = repaintLayout(layout, previous, next);
          const painted = expectEquivalent(f, next, retained), visible = visibility === 'visible';
          const run = imageRun(retained, f.nodeId);
          expect(run.svg).toBe(next.nodesById.get(f.nodeId).svg);
          expect(run.svg.shapes.length).toBe(visible ? 1 : 0);
          expect(run.style.visibility).toBe(visibility);
          expect(painted.items.some(item => item.op === 'drawSvg' && item.nodeId === f.nodeId)).toBe(visible);
          expect(painted.hits.some(hit => hit.nodeId === f.nodeId)).toBe(visible);
          expect(JSON.stringify(layout)).toBe(before);
          previous = next;
          layout = retained;
        }
      } finally { f.window.happyDOM.abort(); }
    });
  }
}

test('a visible SVG overrides its hidden HTML ancestor without exposing the ancestor text', () => {
  const f = fixture('inline', '', 'visibility:hidden;height:24px;overflow:auto');
  try {
    let previous = f.first, layout = f.layout;
    for (const visibility of ['visible', 'hidden', 'visible']) {
      f.svg.style.visibility = visibility;
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      const painted = expectEquivalent(f, next, retained);
      expect(painted.items.some(item => item.op === 'drawSvg' && item.nodeId === f.nodeId)).toBe(visibility === 'visible');
      expect(painted.items.filter(item => item.op === 'drawText').map(item => item.text).join('')).toBe('outside');
      if (visibility === 'visible') expect(painted.scrollers.size).toBeGreaterThan(0);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

test('hidden SVG descendants can restore their shapes during retained root visibility changes', () => {
  const f = fixture();
  try {
    const path = f.svg.querySelector('path');
    let previous = f.first, layout = f.layout;
    for (const [root, child, shapes] of [['hidden', 'visible', 1], ['visible', 'hidden', 0], ['visible', 'visible', 1]]) {
      f.svg.style.visibility = root;
      path.style.visibility = child;
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      const painted = expectEquivalent(f, next, retained);
      expect(imageRun(retained, f.nodeId).svg.shapes.length).toBe(shapes);
      expect(painted.items.some(item => item.op === 'drawSvg' && item.nodeId === f.nodeId)).toBe(root === 'visible' && shapes > 0);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

for (const [description, markup] of [
  ['table row', '<table><tr id="target"><td>cell</td></tr></table>'],
  ['table cell', '<table><tr><td id="target">cell</td></tr></table>'],
]) {
  for (const visibility of ['hidden', 'collapse']) {
    test(`${description} visibility ${visibility} preserves the conservative layout path`, () => {
      const { document, window } = parseHTMLDocument(`<body>${markup}</body>`);
      try {
        const builder = new RenderTreeBuilder(), engine = new LayoutEngine();
        const build = () => builder.build(document, new StyleEngine().compute(document));
        const previous = build(), layout = engine.layout(previous, { width: 300, viewportHeight: 200 });
        document.getElementById('target').style.visibility = visibility;
        expect(repaintLayout(layout, previous, build())).toBeNull();
      } finally { window.happyDOM.abort(); }
    });
  }
}

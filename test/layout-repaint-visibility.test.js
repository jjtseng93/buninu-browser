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
  const builder = new RenderTreeBuilder(), options = { width: 300, viewportHeight: 200 };
  const build = () => builder.build(parsed.document, new StyleEngine().compute(parsed.document));
  const first = build(), layout = new LayoutEngine().layout(first, options);
  return { ...parsed, build, first, layout, options, target: parsed.document.getElementById('target') };
}

function expectEquivalent(f, tree, retained) {
  expect(retained).not.toBeNull();
  const full = new LayoutEngine().layout(tree, f.options);
  // Retaining geometry also retains the fragment's creation generation.
  const comparable = layout => ({ ...layout, fragments: layout.fragments.map(({ id, ...fragment }) => fragment) });
  expect(comparable(retained)).toEqual(comparable(full));
  const painted = buildDisplayList(retained, tree), reference = buildDisplayList(full, tree);
  expect(painted).toEqual(reference);
  // These non-enumerable arrays also carry text run geometry for selection.
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

for (const [description, content] of [
  ['wrapped block text', '<p id="target" style="width:100px">several words <b>to wrap across</b> lines</p>'],
  ['decorated inline text', '<div style="width:100px">before <span id="target" style="background:red;border:1px solid blue">several wrapped words</span> after</div>'],
  ['replaced image', '<div>before <img id="target" width="40" height="30" style="background:red"> after</div>'],
  ['input text', '<input id="target" value="abcdefghij" style="width:100px">'],
  ['textarea text', '<textarea id="target" style="width:100px;height:50px">first line\nsecond line</textarea>'],
  ['absolute clipped content', '<div style="position:relative;overflow:hidden;height:30px"><div id="target" style="position:absolute;top:4px;left:10px;width:100px;height:40px;background:red">absolute</div></div>'],
  ['flex item', '<div style="display:flex;width:180px"><p id="target" style="flex:1">first item</p><p style="flex:1">second item</p></div>'],
  ['grid item', '<div style="display:grid;grid-template-columns:80px 100px"><div id="target">first item</div><div>second item</div></div>'],
]) {
  test(`${description} visibility retains geometry and matches complete paint and hit testing`, () => {
    const f = fixture(content);
    try {
      let previous = f.first, layout = f.layout;
      for (const visibility of ['hidden', 'visible', 'hidden', 'visible']) {
        const before = JSON.stringify(layout);
        f.target.style.visibility = visibility;
        const next = f.build(), retained = repaintLayout(layout, previous, next);
        expectEquivalent(f, next, retained);
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

test('visible descendants of a hidden ancestor keep text selection geometry and scroll reach', () => {
  const f = fixture(`<div id="target" style="width:120px;height:30px;overflow:auto;background:red">
    <p id="shown" style="visibility:visible;margin:0;width:200px;height:70px"><a href="#">visible words</a></p><span>hidden words</span>
    </div>`);
  try {
    let previous = f.first, layout = f.layout;
    for (const visibility of ['hidden', 'visible', 'hidden']) {
      f.target.style.visibility = visibility;
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      const painted = expectEquivalent(f, next, retained);
      const text = painted.items.filter(item => item.op === 'drawText').map(item => item.text).join('');
      expect(text).toContain('visible');
      if (visibility === 'hidden') expect(text).not.toContain('hidden');
      const selectable = painted.hits.filter(hit => hit.textRun).map(hit => hit.textRun.text).join('');
      expect(selectable).toContain('visible');
      if (visibility === 'hidden') expect(selectable).not.toContain('hidden');
      expect(painted.scrollers.size).toBeGreaterThan(0);
      expect(interactiveRegions(next, retained).some(region => region.element.tagName === 'A')).toBe(true);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

test('showing HTML ancestors refreshes inherited SVG shapes as well as text paint', () => {
  const f = fixture(`<div id="target" style="visibility:hidden">label
    <svg width="20" height="20" viewBox="0 0 20 20"><path d="M0 0H20V20H0Z" fill="red"/></svg>
    <svg width="20" height="20" viewBox="0 0 20 20" style="visibility:visible"><circle cx="10" cy="10" r="5"/></svg>
    </div>`);
  try {
    let previous = f.first, layout = f.layout;
    for (const visibility of ['visible', 'hidden', 'visible']) {
      f.target.style.visibility = visibility;
      const next = f.build(), retained = repaintLayout(layout, previous, next);
      const painted = expectEquivalent(f, next, retained);
      expect(painted.items.filter(item => item.op === 'drawSvg').length).toBe(visibility === 'visible' ? 2 : 1);
      for (const fragment of retained.fragments) for (const run of fragment.runs) {
        if (run.svg) expect(run.svg).toBe(next.nodesById.get(run.nodeId).svg);
      }
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

for (const display of ['table', 'inline-table', 'table-row-group', 'table-row', 'table-cell', 'table-column', 'table-column-group', 'table-caption']) {
  for (const visibility of ['hidden', 'collapse']) {
    test(`${display} visibility ${visibility} still requires full layout`, () => {
      const f = fixture(`<div id="target" style="display:${display}">table part</div>`);
      try {
        f.target.style.visibility = visibility;
        expect(repaintLayout(f.layout, f.first, f.build())).toBeNull();
      } finally { f.window.happyDOM.abort(); }
    });
  }
}

test('an HTML ancestor changing inherited table visibility cannot bypass the table guard', () => {
  const f = fixture('<div id="target"><p>ordinary text</p><table><tbody><tr><td>cell</td></tr></tbody></table></div>');
  try {
    let previous = f.first, layout = f.layout;
    for (const visibility of ['hidden', 'visible', 'collapse']) {
      f.target.style.visibility = visibility;
      const next = f.build();
      expect(repaintLayout(layout, previous, next)).toBeNull();
      previous = next;
      layout = new LayoutEngine().layout(next, f.options);
    }
  } finally { f.window.happyDOM.abort(); }
});

test('an unnormalized collapse value is never admitted to the paint-only visibility path', () => {
  const f = fixture('<p id="target">text</p>');
  try {
    const nodesById = new Map();
    const replace = node => {
      const changed = Object.freeze({ ...node,
        style: Object.freeze({ ...node.style, visibility: 'collapse' }),
        children: Object.freeze(node.children.map(replace)),
      });
      nodesById.set(changed.id, changed);
      return changed;
    };
    const next = { ...f.first, root: replace(f.first.root), nodesById };
    expect(repaintLayout(f.layout, f.first, next)).toBeNull();
  } finally { f.window.happyDOM.abort(); }
});

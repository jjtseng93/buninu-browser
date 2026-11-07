import {afterAll, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {LayoutEngine} from '../lib/layout/text-layout.js';
import {buildDisplayList, hitTarget} from '../lib/paint/display-list.js';

// Run the complete paint pipeline with its former node/kind cache keys as an
// oracle. Only this lookup changes; clip, transform and stacking calculations
// remain the same, including non-enumerable hit/scroll metadata.
const moduleURL = new URL('../lib/paint/display-list.js', import.meta.url);
const source = readFileSync(moduleURL, 'utf8');
const sharedKey = 'const key = `${cacheKind}:${owner?.id ?? nodeId}`;';
if (!source.includes(sharedKey)) throw new Error('The effect-cache oracle needs updating');
const referenceSource = source.replace(sharedKey, 'const key = `${kind}:${nodeId}`;')
  .replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(new URL(specifier, moduleURL).href)}`);
const directory = mkdtempSync(join(tmpdir(), 'buninu-effect-cache-'));
const referencePath = join(directory, 'display-list-reference.mjs');
writeFileSync(referencePath, referenceSource);
const {buildDisplayList: referenceList} = await import(pathToFileURL(referencePath).href);
afterAll(() => rmSync(directory, {recursive:true, force:true}));

function fixture(content) {
  const f = parseHTMLDocument(`<!doctype html><body style="margin:0">${content}</body>`);
  const owner = f.document.getElementById('owner');
  if (owner) for (const text of ['FIRST ', 'SECOND ', 'THIRD']) owner.appendChild(f.document.createTextNode(text));
  const engine = new StyleEngine(), builder = new RenderTreeBuilder();
  const layoutEngine = new LayoutEngine({measureText:text => text.length * 8,
    fontMetrics:() => ({ascent:12, height:16})});
  const build = () => {
    const tree = builder.build(f.document, engine.compute(f.document));
    const layout = layoutEngine.layout(tree, {width:320, viewportHeight:240});
    return {tree, layout};
  };
  return {...f, owner, build};
}

function compare({tree, layout}, scrollOffsetOf = null) {
  const actual = buildDisplayList(layout, tree, null, null, scrollOffsetOf);
  const expected = referenceList(layout, tree, null, null, scrollOffsetOf);
  expect(actual).toEqual(expected);
  expect(actual.hits).toEqual(expected.hits);
  expect(actual.scrollers).toEqual(expected.scrollers);
  expect(actual.extent).toEqual(expected.extent);
  expect(actual.images).toEqual(expected.images);
  for (const hit of expected.hits) {
    const x = hit.rect.x + hit.rect.width / 2, y = hit.rect.y + hit.rect.height / 2;
    expect(hitTarget(actual, x, y, {x:0,y:0})).toBe(hitTarget(expected, x, y, {x:0,y:0}));
  }
  return actual;
}

test('multiple text nodes share their ordinary owner effects without changing paint or hit output', () => {
  const f = fixture('<main id="scroll" style="width:180px;height:60px;overflow:auto;transform:translate(-7px,3px)"><div id="owner" style="height:180px;background:red;opacity:.7;transform:scale(.9);transform-origin:0 0"></div></main>');
  try {
    const frame = f.build(), scroller = f.document.getElementById('scroll');
    let actualReads = 0, referenceReads = 0;
    const actual = buildDisplayList(frame.layout, frame.tree, null, null, element => {
      actualReads++;return element === scroller ? {x:5,y:13} : null;
    });
    const reference = referenceList(frame.layout, frame.tree, null, null, element => {
      referenceReads++;return element === scroller ? {x:5,y:13} : null;
    });
    expect(actual.items.filter(item => item.op === 'drawText')).toHaveLength(3);
    expect(actual).toEqual(reference);
    expect(actual.hits).toEqual(reference.hits);
    expect(actualReads).toBeLessThan(referenceReads);
    compare(frame, element => element === scroller ? {x:5,y:13} : null);
  } finally {f.window.happyDOM.close();}
});

test('an owner clips and scrolls text independently from its background', () => {
  for (const overflow of ['clip', 'hidden', 'auto', 'scroll']) {
    const f = fixture(`<div id="owner" style="width:90px;height:20px;overflow:${overflow};border:3px solid black;border-radius:7px;background:red;transform:translate(-11px,-5px) scale(1.2);transform-origin:0 0"></div>`);
    try {
      const frame = f.build();
      const list = compare(frame, element => element === f.owner ? {x:17,y:9} : null);
      const box = list.items.find(item => item.op === 'fillRect');
      const text = list.items.find(item => item.op === 'drawText');
      expect(box).toBeDefined();expect(text).toBeDefined();
      expect(box.clipRect).toBeUndefined();
      expect(text.clipRect).toBeDefined();
      if (overflow === 'clip') expect(text.transform).toEqual(box.transform);
      else expect(text.transform).not.toEqual(box.transform);
    } finally {f.window.happyDOM.close();}
  }
});

test('effect owner reuse preserves controls, table boxes and positioned clipping chains', () => {
  const fixtures = [
    '<div style="overflow:hidden;width:180px;height:80px;transform:translate(-20px,12px)"><div id="owner" style="position:absolute;left:-10px;top:3px;background:red;clip:rect(0px,120px,40px,0px)"></div></div>',
    '<div style="overflow:auto;width:180px;height:80px;transform:scale(.8)"><div id="owner" style="position:fixed;left:-9px;top:-4px;background:red"></div></div>',
    '<div style="overflow:hidden;width:180px;height:80px"><div id="owner" style="position:fixed;left:-9px;top:-4px;background:red;clip-path:inset(1px 2px)"></div></div>',
    '<table style="border-collapse:collapse;transform:translate(-3px,5px)"><tr><td id="owner" style="background:red;border:2px solid blue"></td><td>Other</td></tr></table>',
    '<div style="opacity:.6;transform:translate(-2px,3px)"><input value="An overlong input value" style="width:70px"><textarea style="width:70px;height:30px">Overlong textarea content</textarea><button id="owner"></button></div>',
    '<div style="transform-style:preserve-3d;transform:rotateY(180deg)"><div id="owner" style="backface-visibility:hidden;background:red"></div></div>',
    '<div style="visibility:hidden"><div id="owner" style="visibility:visible;background:red"></div></div>',
  ];
  for (const content of fixtures) {
    const f = fixture(content);
    try {compare(f.build(), () => ({x:8,y:12}));}
    finally {f.window.happyDOM.close();}
  }
});

test('effect caches expire between paints and replacement geometry without mutating earlier frames', () => {
  const f = fixture('<main id="scroll" style="overflow:auto;width:180px;height:40px"><div id="owner" style="height:180px;background:red;transform:translate(-3px,2px)"></div></main>');
  try {
    const frame = f.build(), scroller = f.document.getElementById('scroll');
    let offset = {x:0,y:0};
    const scroll = element => element === scroller ? offset : null;
    const first = compare(frame, scroll), before = JSON.stringify(first);
    offset = {x:9,y:27};
    const second = compare(frame, scroll);
    expect(second.hits).not.toEqual(first.hits);
    expect(JSON.stringify(first)).toBe(before);
    f.owner.style.transform = 'translate(-17px,8px) scale(.5)';
    f.owner.style.opacity = '.3';
    const third = compare(f.build(), scroll);
    expect(third.items).not.toEqual(second.items);
    expect(JSON.stringify(first)).toBe(before);
  } finally {f.window.happyDOM.close();}
});

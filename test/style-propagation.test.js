import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';

function fixture(source, sheets = []) {
  const parsed = parseHTMLDocument(source);
  const engine = new StyleEngine().compute(parsed.document, sheets);
  return { ...parsed, engine, sheets, get: id => parsed.document.getElementById(id) };
}
function self(f, element = f.get('parent')) {
  f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([element]));
}
function fullOracle(f) {
  const full = new StyleEngine().compute(f.document, f.sheets);
  for (const element of f.document.querySelectorAll('*')) {
    expect(f.engine.get(element)).toEqual(full.get(element));
    expect(f.engine.customPropertiesOf(element)).toEqual(full.customPropertiesOf(element));
    for (const pseudo of ['before', 'after']) expect(f.engine.getPseudo(element, pseudo)).toEqual(full.getPseudo(element, pseudo));
  }
}

test('self-only width, padding and opacity updates preserve unaffected descendant styles', () => {
  const f = fixture('<div id="parent"><span id="child"><b id="grandchild">text</b></span></div>');
  try {
    const before = [f.get('child'), f.get('grandchild')].map(element => f.engine.get(element));
    for (const [property, value] of [['width', '180px'], ['padding', '5px'], ['opacity', '.4']]) {
      f.get('parent').style[property] = value;
      self(f);
      expect(f.engine.restyled).toBe(1);
      expect(f.engine.get(f.get('child'))).toBe(before[0]);
      expect(f.engine.get(f.get('grandchild'))).toBe(before[1]);
      fullOracle(f);
    }
  } finally { f.window.happyDOM.abort(); }
});

test('explicit inheritance propagates through dependent children and stops at unchanged ones', () => {
  const f = fixture(`<div id="parent" style="width:100px">
    <div id="child" style="width:inherit"><span id="chain" style="width:inherit">chain</span></div>
    <div id="barrier" style="width:80px"><span id="shielded" style="width:inherit">shielded</span></div></div>`);
  try {
    const shielded = f.engine.get(f.get('shielded'));
    f.get('parent').style.width = '200px';
    self(f);
    expect(f.engine.restyled).toBe(3);
    expect(f.engine.get(f.get('chain')).width).toBe(200);
    expect(f.engine.get(f.get('shielded'))).toBe(shielded);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('dependency metadata changes even when the computed-style identity is retained', () => {
  const f = fixture('<div id="parent" style="width:100px"><span id="child" style="width:100px">text</span></div>');
  try {
    const before = f.engine.get(f.get('child'));
    f.get('child').style.width = 'inherit';
    self(f, f.get('child'));
    expect(f.engine.get(f.get('child'))).toBe(before);
    f.get('parent').style.width = '200px';
    self(f);
    expect(f.engine.restyled).toBe(2);
    expect(f.engine.get(f.get('child')).width).toBe(200);
    const inherited = f.engine.get(f.get('child'));
    f.get('child').style.width = '200px';
    self(f, f.get('child'));
    expect(f.engine.get(f.get('child'))).toBe(inherited);
    f.get('parent').style.width = '300px';
    self(f);
    expect(f.engine.restyled).toBe(1);
    expect(f.engine.get(f.get('child')).width).toBe(200);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

for (const [name, parentStyle, childStyle, property, value, field, expected] of [
  ['resolved variable', 'width:100px;--choice:inherit', 'width:var(--choice)', 'width', '200px', 'width', 200],
  ['variable fallback', 'width:100px', 'width:var(--missing,inherit)', 'width', '200px', 'width', 200],
  ['all shorthand', 'width:100px', 'all:inherit', 'width', '200px', 'width', 200],
  ['variable all shorthand', 'width:100px;--choice:inherit', 'all:var(--choice)', 'width', '200px', 'width', 200],
  ['logical size', 'width:100px', 'inline-size:inherit', 'width', '200px', 'width', 200],
  ['margin shorthand', 'margin:1px', 'margin:inherit', 'margin', '8px', 'margin', [8,8,8,8]],
  ['logical padding shorthand', 'padding:1px', 'padding-inline:inherit', 'padding', '8px', 'padding', [0,8,0,8]],
  ['border shorthand', 'border:1px solid red', 'border:inherit', 'borderWidth', '3px', 'borderWidths', [3,3,3,3]],
]) {
  test(`${name} records explicit parent dependencies`, () => {
    const f = fixture(`<div id="parent" style="${parentStyle}"><span id="child" style="${childStyle}">text</span></div>`);
    try {
      f.get('parent').style[property] = value;
      self(f);
      expect(f.engine.get(f.get('child'))[field]).toEqual(expected);
      fullOracle(f);
    } finally { f.window.happyDOM.abort(); }
  });
}

test('UA table inheritance propagates vertical alignment through rows and cells', () => {
  const f = fixture('<table><tbody id="parent" style="vertical-align:top"><tr id="row"><td id="child">cell</td></tr></tbody></table>');
  try {
    f.get('parent').style.verticalAlign = 'bottom';
    self(f);
    expect(f.engine.restyled).toBe(3);
    expect(f.engine.get(f.get('row')).verticalAlign).toBe('bottom');
    expect(f.engine.get(f.get('child')).verticalAlign).toBe('bottom');
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('stylesheet and pseudo inheritance follow the originating element', () => {
  const f = fixture('<div id="parent" style="width:100px"><span id="child">text</span></div>', [
    '#child { width:inherit } #child::before { content:"x";width:var(--missing,inherit) } #parent[data-ready]::after { content:"ready" }',
  ]);
  try {
    f.get('parent').style.width = '200px';
    self(f);
    expect(f.engine.getPseudo(f.get('child'), 'before').width).toBe(200);
    fullOracle(f);
    const child = f.engine.get(f.get('child'));
    f.get('parent').setAttribute('data-ready', '');
    self(f);
    expect(f.engine.restyled).toBe(1);
    expect(f.engine.get(f.get('child'))).toBe(child);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

for (const [name, parentStyle, childStyle, property, value, field, expected] of [
  ['color scheme', 'color-scheme:light', 'color:light-dark(red,blue)', 'colorScheme', 'dark', 'color', 'rgba(0, 0, 255, 1)'],
  ['line-height factor at equal parent height', 'font-size:10px;line-height:2', 'font-size:20px', 'lineHeight', '20px', 'lineHeight', 20],
  ['parent display and float suppression', 'display:block', 'float:left', 'display', 'flex', 'float', 'none'],
  ['font shorthand', 'font:16px serif', 'font:inherit', 'font', 'italic 20px monospace', 'fontSize', 20],
]) {
  test(`${name} keeps full inherited-input propagation`, () => {
    const f = fixture(`<div id="parent" style="${parentStyle}"><div id="child" style="${childStyle}"><span>descendant</span></div></div>`);
    try {
      f.get('parent').style[property] = value;
      self(f);
      expect(f.engine.restyled).toBe(3);
      expect(f.engine.get(f.get('child'))[field]).toEqual(expected);
      fullOracle(f);
    } finally { f.window.happyDOM.abort(); }
  });
}

test('font inheritance is recorded even when a non-font parent property changes', () => {
  const f = fixture('<div id="parent"><span id="child" style="font:inherit">text</span></div>');
  try {
    f.get('parent').style.width = '200px';
    self(f);
    expect(f.engine.restyled).toBe(2);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('custom properties and propagated decorations remain descendant inputs', () => {
  const f = fixture('<div id="parent" style="--tone:red"><span id="child" style="color:var(--tone)"><i>descendant</i></span></div>');
  try {
    const parent = f.engine.get(f.get('parent'));
    f.get('parent').style.setProperty('--tone', 'blue');
    self(f);
    expect(f.engine.get(f.get('parent'))).toBe(parent);
    expect(f.engine.restyled).toBe(3);
    expect(f.engine.get(f.get('child')).color).toBe('rgba(0, 0, 255, 1)');
    fullOracle(f);
    f.get('parent').style.textDecoration = 'underline';
    self(f);
    expect(f.engine.restyled).toBe(3);
    expect(f.engine.get(f.get('child')).textDecorations.lines).toContain('underline');
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('root font changes reach rem descendants behind a fixed-font child', () => {
  const f = fixture('<html style="font-size:16px"><body style="font-size:8px"><div id="child" style="width:2rem">text</div></body></html>');
  try {
    f.document.documentElement.style.fontSize = '20px';
    self(f, f.document.documentElement);
    expect(f.engine.get(f.get('child')).width).toBe(40);
    expect(f.engine.get(f.get('child')).fontSize).toBe(8);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('partial root propagation keeps independently dirty roots and self-only descendants', () => {
  const f = fixture('<html style="width:100px"><body style="width:inherit"><div id="subtree"><span id="child">text</span></div><p id="other">other</p></body></html>');
  try {
    const root = f.document.documentElement;
    root.style.width = '200px';
    f.get('subtree').style.color = 'red';
    f.get('other').style.color = 'blue';
    f.engine.compute(f.document, f.sheets, {}, new Set([f.get('subtree')]), new Set([root, f.get('other')]));
    expect(f.engine.get(f.document.body).width).toBe(200);
    expect(f.engine.get(f.get('child')).color).toBe('rgba(255, 0, 0, 1)');
    expect(f.engine.get(f.get('other')).color).toBe('rgba(0, 0, 255, 1)');
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('unknown children receive a full first style pass during partial propagation', () => {
  const f = fixture('<div id="parent"><span>old</span></div>');
  try {
    f.get('parent').insertAdjacentHTML('beforeend', '<span id="new" style="width:inherit"><b id="nested">new</b></span>');
    f.get('parent').style.width = '200px';
    self(f);
    expect(f.engine.restyled).toBe(3);
    expect(f.engine.get(f.get('new')).width).toBe(200);
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('an explicitly dirty selector subtree still receives the complete traversal', () => {
  const f = fixture('<div id="parent"><span id="child">text</span></div>', ['.active span { color:red }']);
  try {
    f.get('parent').className = 'active';
    f.engine.compute(f.document, f.sheets, {}, new Set([f.get('parent')]));
    expect(f.engine.restyled).toBe(2);
    expect(f.engine.get(f.get('child')).color).toBe('rgba(255, 0, 0, 1)');
    fullOracle(f);
  } finally { f.window.happyDOM.abort(); }
});

test('a 600-child style update prunes unchanged descendants under SES', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/style-propagation.js', import.meta.url).pathname], { stdout:'pipe', stderr:'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({exit,stdout,stderr}).toEqual({exit:0,stdout:'',stderr:''});
}, 15_000);

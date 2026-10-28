import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { StyleEngine } from '../lib/style/computed-style.js';

function fixture(source, sheets = [], options = {}) {
  const parsed = parseHTMLDocument(source);
  const viewport = { width:800, height:600 };
  const engine = new StyleEngine(options).compute(parsed.document, sheets, viewport);
  return { ...parsed, sheets, options, viewport, engine, get:id => parsed.document.getElementById(id) };
}

function full(f) {
  f.engine.compute(f.document, f.sheets, f.viewport);
  expect(f.engine.incremental).toBe(false);
  expect(f.engine.restyled).toBe(f.document.querySelectorAll('*').length);
  const reference = new StyleEngine(f.options).compute(f.document, f.sheets, f.viewport);
  for (const element of f.document.querySelectorAll('*')) {
    expect(f.engine.get(element)).toEqual(reference.get(element));
    expect(f.engine.customPropertiesOf(element)).toEqual(reference.customPropertiesOf(element));
    for (const pseudo of ['before', 'after']) expect(f.engine.getPseudo(element, pseudo)).toEqual(reference.getPseudo(element, pseudo));
  }
}

test('full cascades retain equal style, custom property and pseudo identities', () => {
  const f = fixture('<div id="parent" style="--tone:red"><span id="child">text</span></div>', [
    '#child {color:var(--tone)} #child::before {content:"before";color:var(--tone)}',
  ]);
  try {
    const child = f.get('child'), style = f.engine.get(child);
    const custom = f.engine.customPropertiesOf(child), pseudo = f.engine.getPseudo(child, 'before');
    f.sheets.push('.unmatched { width:20px }');
    full(f);
    expect(f.engine.get(child)).toBe(style);
    expect(f.engine.customPropertiesOf(child)).toBe(custom);
    expect(f.engine.getPseudo(child, 'before')).toBe(pseudo);
    f.get('parent').style.setProperty('--tone', 'blue');
    full(f);
    expect(f.engine.get(child)).not.toBe(style);
    expect(f.engine.customPropertiesOf(child)).not.toBe(custom);
    expect(f.engine.getPseudo(child, 'before')).not.toBe(pseudo);
    expect(style.color).toBe('rgba(255, 0, 0, 1)');
    expect(custom.get('--tone')).toBe('red');
    expect(pseudo.color).toBe('rgba(255, 0, 0, 1)');
    f.sheets.push('#child::before {content:none} #child::after {content:"after";width:inherit}');
    full(f);
    expect(f.engine.getPseudo(child, 'before')).toBeNull();
    expect(f.engine.getPseudo(child, 'after').content).toBe('after');
  } finally { f.window.happyDOM.abort(); }
});

test('full cascades recompute media, viewport, root rem and font metric inputs', () => {
  let advance = 7;
  const f = fixture('<html style="font-size:2rem"><body><div id="parent" style="width:10vw;direction:rtl"><span id="child" style="font-size:50%;width:2rem;margin-inline-start:3px">text</span><i id="metric" style="width:10ch">metric</i></div></body></html>', [
    '@media(min-width:1000px) { #child {padding:7px} }',
  ], { measureText:() => advance });
  try {
    const oldMetric = f.engine.get(f.get('metric'));
    full(f);
    expect(f.engine.get(f.get('metric'))).toBe(oldMetric);
    advance = 11;
    f.viewport = { width:1200, height:700 };
    f.document.documentElement.style.fontSize = '1.5rem';
    full(f);
    expect(f.engine.get(f.get('parent')).width).toBe(120);
    expect(f.engine.get(f.get('child'))).toMatchObject({ width:48, fontSize:12, padding:[7,7,7,7], margin:[0,3,0,0] });
    expect(f.engine.get(f.get('metric')).width).toBe(110);
    expect(f.engine.get(f.get('metric'))).not.toBe(oldMetric);
    expect(f.engine.usesFontMetrics).toBe(true);
  } finally { f.window.happyDOM.abort(); }
});

test('retaining a full-pass style still refreshes explicit inheritance dependencies', () => {
  const f = fixture('<div id="parent" style="width:100px"><span id="child" style="width:100px">text</span></div>');
  try {
    const original = f.engine.get(f.get('child'));
    f.get('child').style.width = 'inherit';
    full(f);
    expect(f.engine.get(f.get('child'))).toBe(original);
    f.get('parent').style.width = '200px';
    f.engine.compute(f.document, f.sheets, f.viewport, new Set(), new Set([f.get('parent')]));
    expect(f.engine.get(f.get('child')).width).toBe(200);
    const inherited = f.engine.get(f.get('child'));
    f.get('child').style.width = '200px';
    full(f);
    expect(f.engine.get(f.get('child'))).toBe(inherited);
    f.get('parent').style.width = '300px';
    f.engine.compute(f.document, f.sheets, f.viewport, new Set(), new Set([f.get('parent')]));
    expect(f.engine.restyled).toBe(1);
    expect(f.engine.get(f.get('child')).width).toBe(200);
  } finally { f.window.happyDOM.abort(); }
});

test('full-pass maps drop detached nodes and do not restore them on later insertion', () => {
  const f = fixture('<div id="parent"><span id="child" style="width:41px;--private:red">text</span></div>', ['#child::before {content:"x"}']);
  try {
    const child = f.get('child'), old = f.engine.get(child);
    child.remove();
    full(f);
    expect(f.engine.get(child).width).toBe('auto');
    expect(f.engine.customPropertiesOf(child).size).toBe(0);
    expect(f.engine.getPseudo(child, 'before')).toBeNull();
    f.get('parent').appendChild(child);
    f.engine.compute(f.document, f.sheets, f.viewport, new Set([child]));
    expect(f.engine.get(child).width).toBe(41);
    expect(f.engine.get(child)).not.toBe(old);
    f.document.documentElement.remove();
    full(f);
    expect(f.engine.get(child).width).toBe('auto');
    expect(f.engine.getPseudo(child, 'before')).toBeNull();
  } finally { f.window.happyDOM.abort(); }
});

test('a new document cannot reuse adopted nodes from the previous document', () => {
  const f = fixture('<p id="child" style="width:41px;--private:red">text</p>', ['#child::before {content:"x"}']);
  const other = parseHTMLDocument('<body></body>');
  try {
    const child = f.get('child'), oldRoot = f.document.documentElement;
    const old = [f.engine.get(child), f.engine.customPropertiesOf(child), f.engine.getPseudo(child, 'before')];
    other.document.body.appendChild(child);
    f.engine.compute(other.document, f.sheets);
    const current = [f.engine.get(child), f.engine.customPropertiesOf(child), f.engine.getPseudo(child, 'before')];
    for (let i = 0; i < old.length; i++) {
      expect(current[i]).toEqual(old[i]);
      expect(current[i]).not.toBe(old[i]);
    }
    expect(f.engine.get(oldRoot).display).toBe('inline');
  } finally { f.window.happyDOM.abort(); other.window.happyDOM.abort(); }
});

test('a callback starting another document compute cannot access the outer fallback', () => {
  const first = parseHTMLDocument('<html style="width:1ch"><body><p style="color:red">moved</p></body></html>');
  const second = parseHTMLDocument('<body></body>');
  try {
    let trigger = false, nestedStyle;
    const child = first.document.querySelector('p');
    const engine = new StyleEngine({ measureText() {
      if (trigger) {
        trigger = false;
        second.document.body.appendChild(child);
        engine.compute(second.document);
        nestedStyle = engine.get(child);
      }
      return 8;
    } });
    engine.compute(first.document);
    const old = engine.get(child);
    trigger = true;
    engine.compute(first.document);
    expect(nestedStyle).toEqual(old);
    expect(nestedStyle).not.toBe(old);
  } finally { first.window.happyDOM.abort(); second.window.happyDOM.abort(); }
});

test('a failed full traversal cannot retain fallback maps for a later incremental pass', () => {
  const f = fixture('<div id="parent"><span id="child" style="width:41px">text</span></div>');
  try {
    const child = f.get('child'), old = f.engine.get(child);
    Object.defineProperty(f.get('parent'), 'getAttribute', { configurable:true, value() { throw Error('injected failure'); } });
    expect(() => f.engine.compute(f.document, f.sheets)).toThrow('injected failure');
    delete f.get('parent').getAttribute;
    f.engine.compute(f.document, f.sheets, f.viewport, new Set([f.get('parent')]));
    expect(f.engine.get(child).width).toBe(41);
    expect(f.engine.get(child)).not.toBe(old);
    full(f);
  } finally { f.window.happyDOM.abort(); }
});

test('full identity reuse preserves render and layout caches under SES', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/full-style-identity.js', import.meta.url).pathname], { stdout:'pipe', stderr:'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stdout, stderr }).toEqual({ exit:0, stdout:'', stderr:'' });
}, 15_000);

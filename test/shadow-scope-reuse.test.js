import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

const reuse = {reuseUnchangedShadowScopes:true};

function fixture({deferHidden = true, sampleStyle = null, html = ''} = {}) {
  const {window, document} = parseHTMLDocument(html || `<body>
    <section id="outer"><div id="host"><span slot="main" id="assigned"><em>LIGHT</em></span><b id="unslotted">UNSLOTTED</b></div></section>
    <main id="ordinary"><div id="branch"><span id="leaf">TEXT</span></div></main>
    <aside id="sibling"></aside></body>`);
  const get = id => document.getElementById(id);
  const sheets = ['html{font-size:20px}#ordinary::before{content:"BEFORE"}#ordinary::after{content:"AFTER"}#ordinary{--accent:red}#leaf{color:var(--accent);height:2rem}'];
  const scopes = new Map(), knownScopes = new Set();
  const engine = new StyleEngine({deferHidden, sampleStyle});
  const compute = (dirty = [], self = [], options = reuse, viewport = {}) =>
    engine.compute(document, sheets, viewport, new Set(dirty), new Set(self), scopes, options);
  const attach = (host = get('host'), source = ':host{color:purple}::slotted(span){font-weight:bold}', markup = '<section><slot name="main"><i>FALLBACK</i></slot></section>') => {
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = markup;scopes.set(root, [source]);knownScopes.add(root);return root;
  };
  const check = () => {
    const full = new StyleEngine({deferHidden}).compute(document, sheets, {}, null, null, scopes);
    const elements = [...document.querySelectorAll('*'), ...[...knownScopes].flatMap(root => [...root.querySelectorAll('*')])];
    for (const element of elements) {
      expect(engine.get(element)).toEqual(full.get(element));
      expect(engine.customPropertiesOf(element)).toEqual(full.customPropertiesOf(element));
      expect(engine.getPseudo(element, 'before')).toEqual(full.getPseudo(element, 'before'));
      expect(engine.getPseudo(element, 'after')).toEqual(full.getPseudo(element, 'after'));
    }
  };
  compute();
  return {window, document, get, sheets, scopes, knownScopes, engine, compute, attach, check};
}

test('adding a first shadow root retains unrelated styles but rebuilds flat-tree membership', () => {
  const f = fixture();
  try {
    const ordinary = f.get('ordinary'), leaf = f.get('leaf');
    const before = {style:f.engine.get(ordinary), custom:f.engine.customPropertiesOf(ordinary),
      pseudo:f.engine.getPseudo(ordinary, 'before'), leaf:f.engine.get(leaf)};
    const unslotted = f.get('unslotted');
    const scope = f.attach();f.compute();
    expect(f.engine.incremental).toBeFalse();
    expect(f.engine.restyled).toBe(5); // host, shadow section/slot, assigned span/em
    expect(f.engine.get(ordinary)).toBe(before.style);
    expect(f.engine.customPropertiesOf(ordinary)).toBe(before.custom);
    expect(f.engine.getPseudo(ordinary, 'before')).toBe(before.pseudo);
    expect(f.engine.get(leaf)).toBe(before.leaf);
    expect(f.engine.get(leaf).height).toBe(40); // root rem basis was retained
    expect(f.engine.get(unslotted)).toBeNull();
    expect(f.engine.get(scope.querySelector('i'))).toBeNull();f.check();
  } finally {f.window.happyDOM.close();}
});

test('new and edited nested scopes restyle their hosts and all composed descendants', () => {
  const f = fixture();
  try {
    const scope = f.attach();f.compute();
    const ordinary = f.engine.get(f.get('ordinary'));
    const stableHost = f.engine.get(f.get('host'));
    const nestedHost = scope.firstElementChild;
    const nested = f.attach(nestedHost, ':host{--shade:green}article{color:var(--shade)}', '<article><slot></slot></article>');
    f.compute();
    expect(f.engine.get(f.get('host'))).toBe(stableHost);
    expect(f.engine.get(nested.firstElementChild).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.get(f.get('ordinary'))).toBe(ordinary);f.check();
    f.scopes.set(scope, [':host{font-size:31px}::slotted(span){color:blue}']);
    f.compute();
    expect(f.engine.get(nested.firstElementChild).fontSize).toBe(31);
    expect(f.engine.get(f.get('ordinary'))).toBe(ordinary);f.check();
  } finally {f.window.happyDOM.close();}
});

test('removed scopes and empty roots cannot leave styles on discarded rendered nodes', () => {
  const f = fixture();
  try {
    const oldHost = f.get('host'), oldChild = f.get('assigned');
    const scope = f.attach();f.compute();
    const ordinary = f.engine.get(f.get('ordinary'));
    oldHost.remove();f.scopes.delete(scope);
    f.attach(f.get('sibling'), '', '');f.compute([f.get('outer')]);
    expect(f.engine.get(oldHost)).toBeNull();
    expect(f.engine.get(oldChild)).toBeNull();
    expect(f.engine.get(scope.firstElementChild)).toBeNull();
    expect(f.engine.get(f.get('ordinary'))).toBe(ordinary);f.check();
    f.get('outer').append(oldHost);f.scopes.set(scope, [':host{color:blue}']);
    f.compute([f.get('outer')]);
    expect(f.engine.get(oldChild).color).toBe('rgba(0, 0, 255, 1)');f.check();
  } finally {f.window.happyDOM.close();}
});

test('ordinary dirty roots, self changes and new descendants participate in scope reuse', () => {
  const f = fixture();
  try {
    const scope = f.attach();f.compute();
    const branch = f.get('branch'), ordinary = f.get('ordinary');
    branch.style.color = 'blue';
    branch.insertAdjacentHTML('beforeend', '<b id="new">NEW</b>');
    ordinary.style.setProperty('--accent', 'green');
    f.scopes.set(scope, [':host{color:green}']);
    f.compute([branch], [ordinary]);
    expect(f.engine.get(f.get('new')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 128, 0, 1)');f.check();
    // Newly visible composed nodes may have no previous metadata even when
    // their parent was not itself mentioned by the dirty sets.
    const fresh = f.document.createElement('div');fresh.textContent = 'FRESH';
    f.get('sibling').append(fresh);
    f.scopes.set(scope, [':host{color:red}']);f.compute();
    expect(f.engine.get(fresh).display).toBe('block');f.check();
  } finally {f.window.happyDOM.close();}
});

test('root and ancestor output changes propagate inheritance across hosts and slots', () => {
  const f = fixture();
  try {
    f.sheets.push('#outer{width:120px;--accent:red}#host{width:inherit}');
    const scope = f.attach(undefined, 'section,slot,::slotted(span){width:inherit;color:var(--accent);height:2rem}');
    f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
    f.get('outer').style.width = '240px';
    f.get('outer').style.setProperty('--accent', 'green');
    f.document.documentElement.style.fontSize = '25px';
    f.scopes.set(scope, [f.scopes.get(scope)[0] + ':host{background:red}']);
    f.compute([], [f.document.documentElement, f.get('outer')]);
    expect(f.engine.get(f.get('assigned')).width).toBe(240);
    expect(f.engine.get(f.get('assigned')).height).toBe(50);
    expect(f.engine.get(f.get('assigned')).color).toBe('rgba(0, 128, 0, 1)');f.check();
  } finally {f.window.happyDOM.close();}
});

test('retained explicit-inheritance metadata supports the next ordinary incremental pass', () => {
  const f = fixture();
  try {
    const branch = f.get('branch'), leaf = f.get('leaf');
    branch.style.width = '100px';leaf.style.width = 'inherit';f.compute([branch]);
    const before = f.engine.get(leaf);
    f.attach();f.compute();expect(f.engine.get(leaf)).toBe(before);
    branch.style.width = '150px';f.compute([], [branch]);
    expect(f.engine.incremental).toBeTrue();
    expect(f.engine.get(leaf).width).toBe(150);f.check();
  } finally {f.window.happyDOM.close();}
});

test('fresh hidden boundaries become eager around new scopes and lazy after their removal', () => {
  const f = fixture();
  try {
    const outer = f.get('outer');outer.style.display = 'none';f.compute([], [outer]);
    const scope = f.attach();f.compute();
    expect(f.engine.get(f.get('assigned'))).not.toBeNull();f.check();
    const host = f.get('host');host.remove();f.scopes.delete(scope);
    outer.insertAdjacentHTML('beforeend', '<div id="hidden-child" style="width:inherit">HIDDEN</div>');
    outer.style.width = '90px';f.compute([outer]);
    expect(f.engine.get(f.get('hidden-child')).width).toBe(90);f.check();
    outer.style.width = '130px';f.compute([], [outer]);
    expect(f.engine.get(f.get('hidden-child')).width).toBe(130);f.check();
  } finally {f.window.happyDOM.close();}
});

test('shadow-root dirty records force their host while unknown records fall back', () => {
  const f = fixture();
  try {
    const scope = f.attach();f.compute();
    scope.firstElementChild.style.width = '88px';
    f.attach(f.get('sibling'), '', '');f.compute([scope]);
    expect(f.engine.get(scope.firstElementChild).width).toBe(88);f.check();
    f.scopes.set(scope, [':host{color:blue}']);
    f.compute([f.document]);
    expect(f.engine.restyled).toBeGreaterThan(8);f.check();
  } finally {f.window.happyDOM.close();}
});

test('scope reuse requires known document changes, unchanged viewport and complete dirty metadata', () => {
  const f = fixture();
  try {
    const scope = f.attach();f.compute();
    let width = 10;
    const changeScope = () => f.scopes.set(scope, [`:host{width:${width++}px}`]);
    changeScope();f.engine.compute(f.document, f.sheets, {}, null, new Set(), f.scopes, reuse);
    expect(f.engine.restyled).toBeGreaterThan(8);f.check();
    changeScope();f.engine.compute(f.document, f.sheets, {}, new Set(), null, f.scopes, reuse);
    expect(f.engine.restyled).toBeGreaterThan(8);f.check();
    changeScope();f.sheets.push('@media(min-width:1px){#ordinary{font-size:32px}}');f.compute();
    expect(f.engine.restyled).toBeGreaterThan(8);f.check();
    changeScope();f.compute([], [], reuse, {width:900});
    expect(f.engine.restyled).toBeGreaterThan(8);
    changeScope();f.compute([], [], null);
    expect(f.engine.restyled).toBeGreaterThan(8);f.check();
  } finally {f.window.happyDOM.close();}
});

test('either old or new outside selector dependencies retain the full fallback', () => {
  for (const outside of [':host-context(.blue){color:blue}', ':host(:lang(en)){color:blue}', 'section:has(slot){color:blue}']) {
    const f = fixture();
    try {
      const scope = f.attach();f.compute();
      f.scopes.set(scope, [outside]);f.compute();
      expect(f.engine.restyled).toBeGreaterThan(8);f.check();
      f.scopes.set(scope, [':host{color:green}']);f.compute();
      expect(f.engine.restyled).toBeGreaterThan(8);f.check();
    } finally {f.window.happyDOM.close();}
  }
});

test('sampled styles are retained or recomputed from base values, never sampled twice', () => {
  const calls = new Map();
  const f = fixture({sampleStyle(element, style) {
    calls.set(element, (calls.get(element) ?? 0) + 1);
    return element.id === 'ordinary' && typeof style.width === 'number' ? {...style, width:style.width + 5} : style;
  }});
  try {
    f.get('ordinary').style.width = '100px';
    f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
    const ordinary = f.get('ordinary');calls.clear();
    const scope = f.attach();f.compute([], [], {...reuse, sampleStyleDirty:new Set()});
    expect(calls.has(ordinary)).toBeFalse();expect(f.engine.get(ordinary).width).toBe(105);
    f.scopes.set(scope, [':host{color:blue}']);calls.clear();
    f.compute([], [], {...reuse, sampleStyleDirty:new Set([ordinary])});
    expect(calls.get(ordinary)).toBe(1);expect(f.engine.get(ordinary).width).toBe(105);
    f.scopes.set(scope, [':host{color:red}']);calls.clear();
    f.compute(); // A sampler without complete dirty-sample metadata cannot reuse.
    expect(calls.get(ordinary)).toBe(1);expect(f.engine.restyled).toBeGreaterThan(8);
  } finally {f.window.happyDOM.close();}
});

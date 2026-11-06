import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

function fixture({sampleStyle = null} = {}) {
  const {window, document} = parseHTMLDocument(`<body>
    <section id="outer"><div id="host"><span id="light" slot="main"><em>LIGHT</em></span></div></section>
    <main id="ordinary"><div id="branch"><b id="leaf">LEAF</b></div></main>
    <aside id="sibling"></aside>${'<p class="unrelated">UNCHANGED</p>'.repeat(20)}</body>`);
  const get = id => document.getElementById(id);
  const sheets = ['html{font-size:20px}#ordinary{--accent:red;width:100px}#leaf{color:var(--accent);height:2rem}#ordinary::before{content:"BEFORE"}'];
  const scopes = new Map(), allScopes = new Set();
  const attach = (host, css = '', html = '<i>SHADOW</i>') => {
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = html;scopes.set(root, [css]);allScopes.add(root);return root;
  };
  const scope = attach(get('host'), ':host{color:purple}::slotted(span){font-weight:bold}',
    '<section id="frame"><div id="inner">OLD</div><slot name="main"><i id="fallback">FALLBACK</i></slot></section>');
  const engine = new StyleEngine({deferHidden:true, sampleStyle});
  const compute = ({dirty = new Set(), self = new Set(), hosts = new Set([get('host')]),
    options = {}, viewport = {}} = {}) => engine.compute(document, sheets, viewport, dirty, self, scopes,
    {reuseUnchangedShadowScopes:true, scopedMutationHosts:hosts, ...options});
  const check = (extra = [], viewport = {}) => {
    const full = new StyleEngine({deferHidden:true, sampleStyle}).compute(document, sheets, viewport, null, null, scopes);
    const elements = new Set([...document.querySelectorAll('*'),
      ...[...allScopes].flatMap(root => [...root.querySelectorAll('*')]), ...extra]);
    for (const element of elements) {
      expect(engine.get(element)).toEqual(full.get(element));
      expect(engine.customPropertiesOf(element)).toEqual(full.customPropertiesOf(element));
      expect(engine.getPseudo(element, 'before')).toEqual(full.getPseudo(element, 'before'));
      expect(engine.getPseudo(element, 'after')).toEqual(full.getPseudo(element, 'after'));
    }
    return full;
  };
  engine.compute(document, sheets, {}, null, null, scopes);
  return {window, document, get, sheets, scopes, scope, engine, attach, compute, check};
}

test('known mutations in an unchanged scope retain unrelated styles and rebuild composed membership', () => {
  const f = fixture();
  try {
    const ordinary = f.engine.get(f.get('ordinary'));
    const pseudo = f.engine.getPseudo(f.get('ordinary'), 'before');
    const inner = f.scope.querySelector('#inner');
    inner.remove();
    f.scope.querySelector('#frame').insertAdjacentHTML('afterbegin', '<strong id="new" style="color:blue">NEW</strong>');
    f.get('light').slot = 'unmatched';
    f.compute();
    expect(f.engine.incremental).toBeFalse();
    expect(f.engine.get(f.get('ordinary'))).toBe(ordinary);
    expect(f.engine.getPseudo(f.get('ordinary'), 'before')).toBe(pseudo);
    expect(f.engine.get(inner)).toBeNull();
    expect(f.engine.get(f.get('light'))).toBeNull();
    expect(f.engine.get(f.scope.querySelector('#fallback'))).not.toBeNull();
    expect(f.engine.get(f.scope.querySelector('#new')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.restyled).toBeLessThan(f.check([inner]).restyled);
    f.get('light').slot = 'main';f.compute();
    expect(f.engine.get(f.scope.querySelector('#fallback'))).toBeNull();
    expect(f.engine.get(f.get('light')).fontWeight).toBe(700);f.check();
  } finally {f.window.happyDOM.close();}
});

test('known scope mutations merge ordinary dirty roots, ancestor self changes and root rem changes', () => {
  const f = fixture();
  try {
    f.get('branch').style.width = '120px';
    f.get('branch').insertAdjacentHTML('beforeend', '<i id="new">NEW</i>');
    f.get('ordinary').style.setProperty('--accent', 'green');
    f.get('outer').style.color = 'blue';
    f.document.documentElement.style.fontSize = '25px';
    f.scope.querySelector('#inner').style.height = '2rem';
    f.compute({dirty:new Set([f.get('branch')]),
      self:new Set([f.document.documentElement, f.get('ordinary'), f.get('outer')])});
    expect(f.engine.incremental).toBeFalse();
    expect(f.engine.get(f.get('leaf')).height).toBe(50);
    expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.get(f.scope.querySelector('#inner')).height).toBe(50);f.check();
  } finally {f.window.happyDOM.close();}
});

test('outermost hosts cover nested roots while internal dirty and self elements remain supported', () => {
  const f = fixture();
  try {
    const nestedHost = f.scope.querySelector('#inner');
    const nested = f.attach(nestedHost, 'i{color:var(--accent)}');
    f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
    nested.firstElementChild.style.fontSize = '31px';
    nestedHost.style.setProperty('--accent', 'green');
    f.compute({dirty:new Set([nested]), self:new Set([nested.firstElementChild])});
    expect(f.engine.get(nested.firstElementChild).fontSize).toBe(31);
    expect(f.engine.get(nested.firstElementChild).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('known scope mutations merge other changed scopes and safe document stylesheet additions', () => {
  const f = fixture();
  try {
    const other = f.attach(f.get('sibling'), ':host{color:green}');
    f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
    f.scope.querySelector('#inner').style.width = '90px';
    f.scopes.set(other, [':host{color:blue}']);
    f.sheets.push('@supports(display:block){#ordinary{--accent:green}#leaf::after{content:"ADDED"}}');
    f.compute();
    expect(f.engine.get(f.scope.querySelector('#inner')).width).toBe(90);
    expect(f.engine.get(other.firstElementChild).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.getPseudo(f.get('leaf'), 'after')).not.toBeNull();
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('explicit malformed, detached, non-host and nested mutation scopes fall back to a complete cascade', () => {
  for (const kind of ['null', 'array', 'ordinary', 'detached', 'shadow-root', 'nested', 'light-nested', 'foreign']) {
    const f = fixture();let foreign;
    try {
      let hosts;
      if (kind === 'null') hosts = null;
      if (kind === 'array') hosts = [f.get('host')];
      if (kind === 'ordinary') hosts = new Set([f.get('ordinary')]);
      if (kind === 'detached') {
        const detached = f.document.createElement('div');f.attach(detached);hosts = new Set([detached]);
      }
      if (kind === 'shadow-root') hosts = new Set([f.scope]);
      if (kind === 'nested') {
        const nested = f.scope.querySelector('#inner');f.attach(nested);hosts = new Set([nested]);
      }
      if (kind === 'light-nested') {f.attach(f.get('light'));hosts = new Set([f.get('light')]);}
      if (kind === 'foreign') {
        foreign = parseHTMLDocument('<div id="foreign"></div>');
        const host = foreign.document.getElementById('foreign');
        f.scopes.set(host.attachShadow({mode:'closed'}), []);hosts = new Set([host]);
      }
      f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
      f.scope.querySelector('#frame').style.width = '91px';
      f.compute({hosts});
      expect(f.engine.incremental).toBeFalse();
      expect(f.engine.get(f.scope.querySelector('#frame')).width).toBe(91);
      expect(f.engine.restyled).toBeGreaterThan(20);f.check();
    } finally {f.window.happyDOM.close();foreign?.window.happyDOM.close();}
  }
});

test('unknown full invalidations and incomplete dirty sets cannot be made local by known hosts', () => {
  for (const missing of ['dirty', 'self', 'opt-in', 'document']) {
    const f = fixture();
    try {
      f.scope.querySelector('#inner').style.width = '92px';
      const options = missing === 'dirty' ? {dirty:null} : missing === 'self' ? {self:null}
        : missing === 'opt-in' ? {options:{reuseUnchangedShadowScopes:false}} : {dirty:new Set([f.document])};
      f.compute(options);
      expect(f.engine.incremental).toBeFalse();
      expect(f.engine.restyled).toBeGreaterThan(20);f.check();
    } finally {f.window.happyDOM.close();}
  }
});

test('viewport and global document rule changes still reject mutation scope reuse', () => {
  for (const change of ['viewport', 'property', 'replace', 'remove']) {
    const f = fixture();
    try {
      const viewport = change === 'viewport' ? {width:900} : {};
      if (change === 'property') f.sheets.push('@property --accent{syntax:"<color>";inherits:true;initial-value:green}');
      if (change === 'replace') f.sheets[0] += '#leaf{font-size:31px}';
      if (change === 'remove') f.sheets.pop();
      f.scope.querySelector('#inner').style.width = '93px';f.compute({viewport});
      expect(f.engine.restyled).toBeGreaterThan(20);f.check([], viewport);
    } finally {f.window.happyDOM.close();}
  }
});

test('outside shadow selector dependencies retain full invalidation before and after their removal', () => {
  const f = fixture();
  try {
    f.scopes.set(f.scope, [':host-context(.blue){color:blue}']);
    f.engine.compute(f.document, f.sheets, {}, null, null, f.scopes);
    f.get('outer').className = 'blue';f.compute({self:new Set([f.get('outer')])});
    expect(f.engine.restyled).toBeGreaterThan(20);f.check();
    f.scopes.set(f.scope, [':host{color:green}']);f.compute();
    expect(f.engine.restyled).toBeGreaterThan(20);f.check();
  } finally {f.window.happyDOM.close();}
});

test('unchanged scopes retain sampled styles and resample explicit targets from their base values', () => {
  const calls = new Map();
  const f = fixture({sampleStyle(element, style) {
    calls.set(element, (calls.get(element) ?? 0) + 1);
    return element.id === 'ordinary' ? {...style, width:style.width + 5} : style;
  }});
  try {
    calls.clear();f.compute({options:{sampleStyleDirty:new Set()}});
    expect(calls.has(f.get('ordinary'))).toBeFalse();
    expect(f.engine.get(f.get('ordinary')).width).toBe(105);f.check();
    calls.clear();f.compute({options:{sampleStyleDirty:new Set([f.get('ordinary')])}});
    expect(calls.get(f.get('ordinary'))).toBe(1);
    expect(f.engine.get(f.get('ordinary')).width).toBe(105);f.check();
    calls.clear();f.compute();
    expect(calls.get(f.get('ordinary'))).toBe(1);
    expect(f.engine.restyled).toBeGreaterThan(20);f.check();
  } finally {f.window.happyDOM.close();}
});

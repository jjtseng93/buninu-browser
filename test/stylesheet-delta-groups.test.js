import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {parseStyleSheet, StyleEngine} from '../lib/style/computed-style.js';

const viewport = {width: 800, height: 600};
const supports = source => `@supports (display:block){${source}}`;

function parsed(source, dimensions = viewport) {
  const counter = {order: 0};
  const rules = parseStyleSheet(source, dimensions, counter);
  return {rules, selectorOnly: counter.selectorOnly};
}

for (const [name, source, count] of [
  ['ordinary', '#subject{color:blue}', 1],
  ['supports', supports('#subject{color:blue}'), 1],
  ['media', '@media(min-width:700px){#subject{color:blue}}', 1],
  ['nested groups', supports('@media(min-width:700px){#subject{color:blue}}'), 1],
  ['comments and strings', '/* @font-face{} */#subject::before{content:"@keyframes {}; @layer"}', 1],
  ['empty active group', supports(''), 0],
]) {
  test(`the stylesheet parser classifies ${name} rules during its existing parse`, () => {
    const result = parsed(source);
    expect(result.selectorOnly).toBeTrue();
    expect(result.rules).toHaveLength(count);
  });
}

for (const [name, source] of [
  ['layer block', '@layer added{#subject{color:blue}}'],
  ['layer statement', '@layer earlier,later;#subject{color:blue}'],
  ['property', '@property --tone{syntax:"<color>";inherits:false;initial-value:blue}'],
  ['font-face', '@font-face{font-family:Added;src:url(added.woff2)}'],
  ['keyframes', '@keyframes added{from{opacity:0}to{opacity:1}}'],
  ['unknown block', '@unknown thing{#subject{color:blue}}'],
  ['unknown statement', '@unknown thing;'],
  ['import', '@import url(other.css);'],
]) {
  test(`a nested ${name} prevents selector-only delta invalidation`, () => {
    expect(parsed(supports(source)).selectorOnly).toBeFalse();
    expect(parsed(`@media(min-width:700px){${supports(source)}}`).selectorOnly).toBeFalse();
  });
}

test('unvisited inactive groups and incomplete constructs keep conservative metadata', () => {
  for (const source of [
    '@media(min-width:999999px){#subject{color:blue}}',
    '@supports(width:unsupported-value){#subject{color:blue}}',
    supports('@media(min-width:999999px){@font-face{font-family:Hidden;src:url(hidden.woff)}}'),
    supports('@unknown unfinished'),
    '@supports(display:block){#subject{color:blue}',
  ]) expect(parsed(source).selectorOnly).toBeFalse();
});

function fixture() {
  const {window, document} = parseHTMLDocument(`<body>
    <main id="subject"><span id="child">TARGET</span></main><div id="host"></div>
    <aside id="stable"><b>UNCHANGED</b><i>ALSO UNCHANGED</i></aside></body>`);
  const f = {window, document, viewport: {...viewport}, scopes: new Map(),
    sheets: ['#subject{--tone:red}#child{color:var(--tone)}'], engine: new StyleEngine()};
  f.get = id => document.getElementById(id);
  f.compute = () => f.engine.compute(document, f.sheets, f.viewport,
    new Set(), new Set(), f.scopes, {reuseUnchangedShadowScopes: true});
  f.attach = () => {
    const scope = f.get('host').attachShadow({mode: 'closed'});
    scope.innerHTML = '<section><b>SHADOW</b></section>';
    f.scopes.set(scope, ['section{color:green}']);
    return scope;
  };
  f.check = () => {
    const full = new StyleEngine().compute(document, f.sheets, f.viewport, null, null, f.scopes);
    const elements = [...document.querySelectorAll('*'),
      ...[...f.scopes.keys()].flatMap(scope => [...scope.querySelectorAll('*')])];
    for (const element of elements) {
      expect([element.id, f.engine.get(element)]).toEqual([element.id, full.get(element)]);
      expect(f.engine.customPropertiesOf(element)).toEqual(full.customPropertiesOf(element));
      expect(f.engine.getPseudo(element, 'before')).toEqual(full.getPseudo(element, 'before'));
      expect(f.engine.getPseudo(element, 'after')).toEqual(full.getPseudo(element, 'after'));
    }
    return full;
  };
  f.compute();
  return f;
}

test('active conditional additions combine with shadow changes, including inherited variables and pseudo elements', () => {
  const f = fixture();
  try {
    const stable = f.engine.get(f.get('stable'));
    f.attach();
    f.sheets.push(supports(`@media(min-width:700px){
      #subject{--tone:blue}#child::before{content:"ADDED";color:var(--tone)}
    }`));
    f.compute();
    expect(f.engine.get(f.get('child')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.getPseudo(f.get('child'), 'before').color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(f.get('stable'))).toBe(stable);
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('cached conditional metadata remains usable for a later duplicate sheet and new scope change', () => {
  const f = fixture();
  try {
    const source = supports('#child{color:blue}');
    f.sheets.push(source, '#child{color:green}');f.compute();
    const stable = f.engine.get(f.get('stable'));
    f.attach();f.sheets.push(source);f.compute();
    expect(f.engine.get(f.get('child')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(f.get('stable'))).toBe(stable);
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('conditional additions stay incremental without scopes but viewport changes rebuild their conditions', () => {
  const f = fixture();
  try {
    f.sheets.push('@media(min-width:700px){#child{width:55px}}');f.compute();
    expect(f.engine.incremental).toBeTrue();
    expect(f.engine.restyled).toBe(1);
    expect(f.engine.get(f.get('child')).width).toBe(55);f.check();
    f.viewport.width = 600;f.compute();
    expect(f.engine.incremental).toBeFalse();
    expect(f.engine.get(f.get('child')).width).toBe('auto');
    expect(f.engine.restyled).toBe(f.check().restyled);
    f.viewport.width = 800;f.compute();
    expect(f.engine.get(f.get('child')).width).toBe(55);f.check();
  } finally {f.window.happyDOM.close();}
});

test('nested global definitions, unknown statements and inactive groups retain the complete cascade', () => {
  for (const source of [
    supports('@layer inserted{#child{color:blue}}'),
    supports('@property --tone{syntax:"<color>";inherits:false;initial-value:blue}'),
    supports('@font-face{font-family:Added;src:url(added.woff2)}'),
    supports('@keyframes inserted{from{opacity:0}to{opacity:1}}'),
    supports('@unknown added;'),
    '@supports(width:unsupported-value){#child{color:blue}}',
    '@media(min-width:999999px){#child{color:blue}}',
  ]) {
    const f = fixture();
    try {
      f.attach();f.sheets.push(source);f.compute();
      expect(f.engine.restyled).toBe(f.check().restyled);
    } finally {f.window.happyDOM.close();}
  }
});

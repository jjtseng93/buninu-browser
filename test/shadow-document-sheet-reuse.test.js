import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

const reuse = {reuseUnchangedShadowScopes: true};

function fixture() {
  const {window, document} = parseHTMLDocument(`<body>
    <main id="ordinary"><div id="branch"><span id="leaf">TEXT</span></div></main>
    <div id="host"><span slot="main" id="assigned">LIGHT</span><b>UNSLOTTED</b></div>
    <aside id="stable"><p><b>UNCHANGED</b></p><p>ALSO UNCHANGED</p></aside>
  </body>`);
  const f = {
    window, document, scopes: new Map(), knownScopes: new Set(),
    sheets: ['html{font-size:20px}#ordinary{--accent:red}#leaf{color:var(--accent);height:2rem}'],
    engine: new StyleEngine(), get: id => document.getElementById(id),
  };
  f.compute = (dirty = [], self = [], options = reuse) =>
    f.engine.compute(document, f.sheets, {}, new Set(dirty), new Set(self), f.scopes, options);
  f.attach = () => {
    const scope = f.get('host').attachShadow({mode: 'closed'});
    scope.innerHTML = '<section><slot name="main"></slot><i id="inner">SHADOW</i></section>';
    f.scopes.set(scope, ['section{font-size:inherit}i{color:var(--tone,black)}']);
    f.knownScopes.add(scope);
    return scope;
  };
  f.check = () => {
    const full = new StyleEngine().compute(document, f.sheets, {}, null, null, f.scopes);
    const elements = [...document.querySelectorAll('*'),
      ...[...f.knownScopes].flatMap(scope => [...scope.querySelectorAll('*')])];
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

test('ordinary document additions merge with a first scope and preserve unrelated styles', () => {
  const f = fixture();
  try {
    const stable = f.engine.get(f.get('stable'));
    f.attach();
    // Mutating the original array must still compare against its old sources.
    f.sheets.push('#leaf{width:31px}');
    f.compute();
    expect(f.engine.incremental).toBeFalse(); // still rebuilds the composed tree
    expect(f.engine.get(f.get('leaf')).width).toBe(31);
    expect(f.engine.get(f.get('stable'))).toBe(stable);
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('added rules, pseudo elements, inheritance, variables and ordinary dirtiness all participate', () => {
  const f = fixture();
  try {
    const scope = f.attach();f.compute();
    const stable = f.engine.get(f.get('stable'));
    f.get('branch').style.width = '75px';
    f.get('branch').insertAdjacentHTML('beforeend', '<b id="new">NEW</b>');
    f.get('ordinary').style.fontSize = '25px';
    f.scopes.set(scope, [':host{font-weight:700}']);
    f.sheets = [...f.sheets, `#ordinary{color:blue;--accent:green}
      #ordinary::before{content:"BEFORE";color:var(--accent)}
      #ordinary::after{content:"AFTER";font-size:inherit}`];
    f.compute([f.get('branch')], [f.get('ordinary')]);
    expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.get(f.get('new')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.getPseudo(f.get('ordinary'), 'before').color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.getPseudo(f.get('ordinary'), 'after').fontSize).toBe(25);
    expect(f.engine.get(f.get('stable'))).toBe(stable);
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('new document rules inherit through hosts and slots without leaking selectors into a shadow root', () => {
  const f = fixture();
  try {
    const scope = f.attach();
    f.sheets.push('#host{color:blue;font-size:29px;--tone:green}i{color:red}');
    f.compute();
    expect(f.engine.get(f.get('assigned')).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(f.get('assigned')).fontSize).toBe(29);
    expect(f.engine.get(scope.querySelector('i')).color).toBe('rgba(0, 128, 0, 1)');
    expect(f.engine.restyled).toBeLessThan(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('added root rules recompute rem descendants and generated content', () => {
  const f = fixture();
  try {
    f.attach();f.sheets.push('html{font-size:30px;--root:blue}#leaf::before{content:"X";color:var(--root)}');
    f.compute();
    expect(f.engine.get(f.get('leaf')).height).toBe(60);
    expect(f.engine.getPseudo(f.get('leaf'), 'before').color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.restyled).toBe(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

test('sheet invalidation uses the same selector matcher as the cascade, including :scope', () => {
  const f = fixture();
  const query = f.document.querySelectorAll;
  try {
    f.attach();
    f.sheets.push(':scope#leaf{width:91px}:is(#ordinary,.absent)::before{content:"MATCHED"}');
    // A qSA failure must not silently omit matching subjects. The cascade
    // interprets :scope as the element tested, not document.querySelectorAll's root.
    f.document.querySelectorAll = () => {throw new Error('unexpected document qSA');};
    f.compute();
    expect(f.engine.get(f.get('leaf')).width).toBe(91);
    expect(f.engine.getPseudo(f.get('ordinary'), 'before')).not.toBeNull();
    f.document.querySelectorAll = query;
    f.check();
  } finally {f.document.querySelectorAll = query;f.window.happyDOM.close();}
});

test('insertion and duplicate ordinary sheets retain the unchanged relative cascade order', () => {
  const f = fixture();
  try {
    const a = '#leaf{color:blue}', b = '#leaf{color:green}';
    f.sheets.push(a, b);f.compute();
    const scope = f.attach();f.compute();
    const stable = f.engine.get(f.get('stable'));
    for (const [index, next] of [[1, '#leaf{width:15px}'], [4, a]]) {
      f.sheets.splice(index, 0, next);
      f.scopes.set(scope, [`:host{width:${index}px}`]);
      f.compute();
      expect(f.engine.get(f.get('stable'))).toBe(stable);
      expect(f.engine.restyled).toBeLessThan(f.check().restyled);
    }
    expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 0, 255, 1)');
  } finally {f.window.happyDOM.close();}
});

for (const [name, source] of [
  ['layer', '@layer added{#leaf{color:blue}}'],
  ['property', '@property --tone{syntax:"<color>";inherits:false;initial-value:blue}'],
  ['font-face', '@font-face{font-family:Added;src:url(added.woff2)}'],
  ['keyframes', '@keyframes added{from{opacity:0}to{opacity:1}}'],
  ['media', '@media(min-width:1px){#leaf{width:21px}}'],
  ['unknown at-rule', '@unknown something;'],
]) {
  test(`a newly added ${name} sheet keeps the full cascade fallback`, () => {
    const f = fixture();
    try {
      f.attach();f.sheets.push(source);f.compute();
      expect(f.engine.restyled).toBe(f.check().restyled);
    } finally {f.window.happyDOM.close();}
  });
}

for (const changeScope of [false, true]) {
  test(`removed rules and an already removed matching class cannot retain stale descendants (scope=${changeScope})`, () => {
    const f = fixture();
    try {
      f.get('ordinary').className = 'old';
      f.sheets.push('.old #leaf{color:blue}');f.compute();
      expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 0, 255, 1)');
      if (changeScope) f.attach();
      f.get('ordinary').className = '';
      f.sheets.pop();
      // Only the ancestor is explicitly dirty. The old selector cannot be
      // recovered by matching against the new class list, so removal is full.
      f.compute([], [f.get('ordinary')]);
      expect(f.engine.get(f.get('leaf')).color).toBe('rgba(255, 0, 0, 1)');
      expect(f.engine.incremental).toBeFalse();
      expect(f.engine.restyled).toBe(f.check().restyled);
    } finally {f.window.happyDOM.close();}
  });
}

test('same-length replacement and reordered old sheets cannot reuse unrelated scope styles', () => {
  for (const change of ['replace', 'reorder']) {
    const f = fixture();
    try {
      f.sheets.push('#leaf{color:blue}', '#leaf{color:green}');f.compute();
      f.attach();
      if (change === 'replace') f.sheets[2] = '#stable{width:77px}';
      else [f.sheets[1], f.sheets[2]] = [f.sheets[2], f.sheets[1]];
      f.compute();
      expect(f.engine.get(f.get('leaf')).color).toBe('rgba(0, 0, 255, 1)');
      expect(f.engine.restyled).toBe(f.check().restyled);
    } finally {f.window.happyDOM.close();}
  }
});

test('large added rule sets retain the bounded full-cascade fallback', () => {
  const f = fixture();
  try {
    f.attach();
    f.sheets.push(Array.from({length:301}, (_, index) => `.absent${index}{color:blue}`).join(''));
    f.compute();expect(f.engine.restyled).toBe(f.check().restyled);
  } finally {f.window.happyDOM.close();}
});

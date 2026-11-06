import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {compileShadowSelector, shadowSelectorDependsOnOutside} from '../lib/style/shadow-selectors.js';
import {touchesShadowScope} from '../lib/style/shadow-invalidation.js';

function fixture(shadowSheet = ':host{color:purple}::slotted(.assigned){font-weight:bold}') {
  const {window, document} = parseHTMLDocument('<body><section id="outer"><div id="host"><span slot="main" class="assigned">LIGHT</span><b>HIDDEN</b></div></section><main id="ordinary"><div id="branch"><span>TEXT</span></div></main><aside id="sibling"></aside></body>');
  const get = id => document.getElementById(id);
  const host = get('host'), root = host.attachShadow({mode:'closed'});
  root.innerHTML = '<div class="inner"><slot name="main"><i>FALLBACK</i></slot></div>';
  const scopes = new Map([[root, [shadowSheet]]]);
  const sheets = ['.blue{color:blue}.blue span{font-size:24px}main::before{content:"B"}'];
  const engine = new StyleEngine({deferHidden:true}).compute(document, sheets, {}, null, null, scopes);
  const check = () => {
    const full = new StyleEngine().compute(document, sheets, {}, null, null, scopes);
    for (const element of [...document.querySelectorAll('*'), ...[...scopes.keys()].flatMap(scope => [...scope.querySelectorAll('*')])]) {
      expect(engine.get(element)).toEqual(full.get(element));
      expect(engine.customPropertiesOf(element)).toEqual(full.customPropertiesOf(element));
      expect(engine.getPseudo(element, 'before')).toEqual(full.getPseudo(element, 'before'));
    }
  };
  const compute = (roots = [], self = []) => engine.compute(document, sheets, {}, new Set(roots), new Set(self), scopes);
  return {window, document, get, host, root, scopes, sheets, engine, check, compute};
}

test('ordinary subtrees update incrementally alongside closed shadow roots', () => {
  const f = fixture();
  try {
    const branch = f.get('branch');
    branch.className = 'blue';
    f.compute([branch]);
    expect(f.engine.incremental).toBeTrue();expect(f.engine.restyled).toBe(2);f.check();
    branch.style.backgroundColor = 'red';
    f.compute([], [branch]);
    expect(f.engine.incremental).toBeTrue();expect(f.engine.restyled).toBe(1);f.check();
    branch.append(f.document.createElement('b'));
    f.compute([branch]);
    expect(f.engine.incremental).toBeTrue();expect(f.engine.restyled).toBe(3);f.check();
    branch.style.display = 'none';
    f.compute([], [branch]);
    expect(f.engine.incremental).toBeTrue();f.check();
    branch.style.color = 'green';
    f.compute([], [branch]);f.check();
  } finally {f.window.happyDOM.close();}
});

test('slot changes, host ancestry, and shadow nodes retain coherent full traversal', () => {
  const f = fixture();
  try {
    const cases = [
      [f.host.firstElementChild, () => f.host.firstElementChild.removeAttribute('slot')],
      [f.root.firstElementChild, () => f.root.firstElementChild.style.color = 'red'],
      [f.get('outer'), () => f.get('outer').style.fontSize = '27px'],
      [f.document.body, () => f.document.body.style.setProperty('--new', 'green')],
    ];
    for (const [node, change] of cases) {
      change();f.compute([], [node]);expect(f.engine.incremental).toBeFalse();f.check();
    }
    expect(touchesShadowScope(f.root, [f.root])).toBeTrue();
    expect(touchesShadowScope(f.host.firstChild, [f.root])).toBeTrue();
    expect(touchesShadowScope(f.get('branch'), [f.root])).toBeFalse();
  } finally {f.window.happyDOM.close();}
});

test('scope replacement and scoped rule edits cannot reuse stale styles', () => {
  const f = fixture();
  try {
    f.scopes.set(f.root, [':host{color:green}']);
    f.compute();expect(f.engine.incremental).toBeFalse();f.check();
    const next = f.get('sibling').attachShadow({mode:'open'});
    next.innerHTML = '<em>NEW</em>';
    f.host.remove();f.scopes.delete(f.root);f.scopes.set(next, [':host{color:blue}']);
    f.compute();expect(f.engine.incremental).toBeFalse();f.check();
  } finally {f.window.happyDOM.close();}
});

test('document sheet changes that reach a host fall back before DOM-only traversal', () => {
  const f = fixture();
  try {
    const sheets = [...f.sheets, '#host{font-size:29px}'];
    f.engine.compute(f.document, sheets, {}, new Set(), null, f.scopes);
    expect(f.engine.incremental).toBeFalse();
    f.sheets.push(sheets.at(-1));f.check();
  } finally {f.window.happyDOM.close();}
});

test('invalid shadow selectors stay isolated from valid scoped rules', () => {
  const f = fixture(':host{color:green}.inner:unknown-pseudo(){font-size:99px}::slotted(.a .b){font-size:88px}.inner{font-size:21px}');
  try {
    expect(f.engine.get(f.root.firstElementChild).fontSize).toBe(21);
    f.get('branch').className = 'blue';
    expect(() => f.compute([f.get('branch')])).not.toThrow();f.check();
  } finally {f.window.happyDOM.close();}
});

test('nested shadow selector dependencies conservatively preserve outside invalidation', () => {
  const f = fixture();
  try {
    const depends = selector => shadowSelectorDependsOnOutside(f.host, compileShadowSelector(f.host, selector));
    for (const selector of [':host', ':host(.enabled)', ':host([open])', '.inner', ':is(:host,.inner)', '::slotted(.assigned)', ':host(:popover-open)', ':host(:is(.north,.south))', ':host(:where(:not(.disabled)))'])
      expect(depends(selector)).toBeFalse();
    for (const selector of [':host-context(.theme)', ':is(:host-context(.theme),.inner)', ':where(:not(:host-context(.theme)))', ':host(:has(+ .enabled))', ':host(:nth-child(2))', ':host:first-child', '.inner:has(.enabled)', ':host(:is(.first + .second))', ':host(:not(:has(+ .enabled)))', ':host:valid'])
      expect(depends(selector)).toBeTrue();
    f.scopes.set(f.root, [':host-context(body:has(.enabled)){color:red}']);
    f.compute();
    f.get('sibling').className = 'enabled';
    f.compute([], [f.get('sibling')]);
    expect(f.engine.incremental).toBeFalse();f.check();
    f.scopes.set(f.root, [':host(:has(+ .enabled)){font-size:31px}']);
    f.compute();
    f.host.after(f.get('sibling'));
    f.compute([], [f.get('sibling')]);
    expect(f.engine.incremental).toBeFalse();f.check();
  } finally {f.window.happyDOM.close();}
});

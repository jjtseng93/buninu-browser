import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

function fixture(source, sheets = []) {
  const parsed = parseHTMLDocument(source);
  return {...parsed, sheets, engine: new StyleEngine().compute(parsed.document, sheets)};
}

function matchesFull({document, sheets, engine}) {
  const reference = new StyleEngine().compute(document, sheets);
  for (const element of document.querySelectorAll('*')) {
    expect(engine.get(element)).toEqual(reference.get(element));
    expect(engine.customPropertiesOf(element)).toEqual(reference.customPropertiesOf(element));
    for (const pseudo of ['before', 'after']) expect(engine.getPseudo(element, pseudo)).toEqual(reference.getPseudo(element, pseudo));
  }
}

test('an unchanged root-only selector match does not recascade its descendants', () => {
  const f = fixture('<html><body><div><span>content</span></div></body></html>', ['html[data-check] { opacity:1 }']);
  try {
    const root = f.document.documentElement;
    const retained = [...f.document.querySelectorAll('*')].map(element => [element, f.engine.get(element)]);
    root.setAttribute('data-check', 'ready');
    f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([root]));
    expect(f.engine.restyled).toBe(1);
    for (const [element, style] of retained) expect(f.engine.get(element)).toBe(style);
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

test('an unchanged root still processes simultaneous dirty subtrees and self-only elements', () => {
  const f = fixture('<html><body><div id="subtree"><span>first</span></div><p id="other">other</p></body></html>', ['html[data-check] { opacity:1 }']);
  try {
    const root = f.document.documentElement, subtree = f.document.querySelector('#subtree'), other = f.document.querySelector('#other');
    root.setAttribute('data-check', 'ready');
    subtree.style.color = 'red';
    subtree.insertAdjacentHTML('beforeend', '<span>new</span>');
    other.style.color = 'blue';
    f.engine.compute(f.document, f.sheets, {}, new Set([subtree]), new Set([root, other]));
    expect(f.engine.restyled).toBe(5);
    expect(f.engine.get(subtree.lastElementChild).color).toBe('rgba(255, 0, 0, 1)');
    expect(f.engine.get(other).color).toBe('rgba(0, 0, 255, 1)');
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

test('root-only font changes update inherited and rem sizes using the initial root font basis', () => {
  const f = fixture('<html style="font-size:2rem"><body><div id="child" style="width:2rem;font-size:150%">text</div></body></html>');
  try {
    const root = f.document.documentElement, child = f.document.querySelector('#child');
    // Rechecking the unchanged root must not multiply 2rem by its prior 32px.
    f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([root]));
    expect(f.engine.restyled).toBe(1);
    expect(f.engine.get(root).fontSize).toBe(32);
    expect(f.engine.get(child)).toMatchObject({width:64, fontSize:48});
    root.style.fontSize = '1.5rem';
    f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([root]));
    expect(f.engine.get(root).fontSize).toBe(24);
    expect(f.engine.get(child)).toMatchObject({width:48, fontSize:36});
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

test('root custom properties and explicit inheritance still recascade descendants', () => {
  const f = fixture('<html style="--accent:red;width:120px"><body style="width:inherit"><div id="child" style="color:var(--accent);width:inherit">text</div></body></html>');
  try {
    const root = f.document.documentElement, child = f.document.querySelector('#child');
    const before = f.engine.get(root);
    root.style.setProperty('--accent', 'blue');
    child.insertAdjacentHTML('beforeend', '<span>inserted during the root change</span>');
    f.engine.compute(f.document, f.sheets, {}, new Set([child]), new Set([root]));
    expect(f.engine.get(root)).toBe(before);
    expect(f.engine.get(child).color).toBe('rgba(0, 0, 255, 1)');
    expect(f.engine.get(child.lastElementChild).color).toBe('rgba(0, 0, 255, 1)');
    matchesFull(f);
    root.style.width = '200px';
    f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([root]));
    expect(f.engine.get(child).width).toBe(200);
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

test('a root feature used by descendant selectors keeps the subtree invalidation path', () => {
  const f = fixture('<html><body><div class="target">text</div></body></html>', ['html.active .target { color:red }']);
  try {
    const root = f.document.documentElement;
    root.className = 'active';
    f.engine.compute(f.document, f.sheets, {}, new Set([root]), new Set([root]));
    expect(f.engine.get(f.document.querySelector('.target')).color).toBe('rgba(255, 0, 0, 1)');
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

test('root pseudo changes remain observable with an unchanged principal style', () => {
  const f = fixture('<html><body><div>text</div></body></html>', ['html[data-check]::before { content:"ready";color:red }']);
  try {
    const root = f.document.documentElement;
    root.setAttribute('data-check', 'ready');
    f.engine.compute(f.document, f.sheets, {}, new Set(), new Set([root]));
    expect(f.engine.getPseudo(root, 'before').content).toBe('ready');
    matchesFull(f);
  } finally { f.window.happyDOM.abort(); }
});

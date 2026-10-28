import '../../vendor/ses/dist/ses.mjs';
import assert from 'node:assert/strict';
import { parseHTMLDocument } from '../../lib/happy-dom/parser.js';
import { matchSelectors, StyleEngine } from '../../lib/style/computed-style.js';

const source = `<body class="scope scope"><section id="outer" class="shared shared shared">
  <div id="branch" class="branch branch shared shared"><span id="deep" class="target target alternate alternate">deep</span></div>
  <span id="after" class="target target">after nested duplicates</span>
  </section><section id="other" class="shared shared"><span id="later" class="target target">later branch</span></section>
  <span id="outside" class="target target alternate">outside</span></body>`;
const sheets = [`
  .target { color:black; width:1px }
  .shared .target { color:red; width:11px; --tone:blue }
  .branch .target { height:7px }
  :is(.target, .alternate) { padding:2px }
  .target.target { font-weight:700 }
  .shared .target::before { content:"marker"; color:var(--tone) }
  .scope .target { border:1px solid currentColor }
  .missing .target { color:lime !important }
`];
const duplicate = parseHTMLDocument(source), canonical = parseHTMLDocument(source);
const nodes = document => [...document.querySelectorAll('*')];
const normalizeClasses = () => {
  const left = nodes(duplicate.document), right = nodes(canonical.document);
  for (let index = 0; index < left.length; index++) {
    right[index].setAttribute('class', [...new Set((left[index].getAttribute('class') ?? '').split(/\s+/).filter(Boolean))].join(' '));
    const style = left[index].getAttribute('style');
    if (style === null) right[index].removeAttribute('style');
    else right[index].setAttribute('style', style);
  }
};
normalizeClasses();
const engine = new StyleEngine().compute(duplicate.document, sheets);
new StyleEngine().compute(canonical.document, sheets); // Warm DOM/style paths before lockdown.
if (process.argv[2] === 'ses') lockdown({
  errorTaming: 'safe', overrideTaming: 'severe', consoleTaming: 'unsafe',
  localeTaming: 'unsafe', stackFiltering: 'concise', reporting: 'none',
});

const get = id => duplicate.document.getElementById(id);
const ids = elements => [...elements].map(element => element.id);
const selectors = ['.shared .target', '.branch .target', ':is(.target, .alternate)', '.target.target', '.missing .target'];
function verify() {
  normalizeClasses();
  const reference = new StyleEngine().compute(canonical.document, sheets);
  const left = nodes(duplicate.document), right = nodes(canonical.document);
  for (let index = 0; index < left.length; index++) {
    assert.deepEqual(engine.get(left[index]), reference.get(right[index]));
    assert.deepEqual(engine.customPropertiesOf(left[index]), reference.customPropertiesOf(right[index]));
    for (const pseudo of ['before', 'after']) assert.deepEqual(engine.getPseudo(left[index], pseudo), reference.getPseudo(right[index], pseudo));
  }
  const matched = matchSelectors(duplicate.document, selectors);
  for (const selector of selectors) assert.deepEqual(ids(matched.get(selector)), ids(canonical.document.querySelectorAll(selector)), selector);
  // Exiting the nested shared/branch keys must preserve the outer shared
  // count for the next sibling, then restore it before the outside element.
  for (const id of ['deep', 'after', 'later']) assert.equal(engine.get(get(id)).color, 'rgba(255, 0, 0, 1)');
  assert.equal(engine.get(get('outside')).color, 'rgba(0, 0, 0, 1)');
  assert.deepEqual(ids(matched.get('.shared .target')), ['deep', 'after', 'later']);
  assert.deepEqual(ids(matched.get(':is(.target, .alternate)')), ['deep', 'after', 'later', 'outside']);
}

try {
  // Traverse push/pop after lockdown as well as during the initial warmup.
  engine.compute(duplicate.document, sheets);
  verify();
  assert.equal(engine.get(get('deep')).height, 7);
  assert.equal(engine.get(get('after')).height, 'auto');
  for (const classes of ['shared shared', 'branch branch shared shared shared']) {
    get('branch').className = classes;
    engine.compute(duplicate.document, sheets, {}, new Set([get('outer'), get('other')]));
    assert.equal(engine.incremental, true);
    verify();
    assert.equal(engine.get(get('deep')).height, classes.includes('branch') ? 7 : 'auto');
  }
  // Separate dirty roots build ancestor filters through repeated class keys.
  get('deep').style.width = '23px';
  get('later').style.width = '29px';
  engine.compute(duplicate.document, sheets, {}, new Set([get('deep'), get('later')]));
  assert.equal(engine.restyled, 2);
  verify();
  assert.equal(engine.get(get('deep')).width, 23);
  assert.equal(engine.get(get('later')).width, 29);
} finally {
  duplicate.window.happyDOM.abort();
  canonical.window.happyDOM.abort();
}

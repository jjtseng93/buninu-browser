import '../../vendor/ses/dist/ses.mjs';
import assert from 'node:assert/strict';
import { parseHTMLDocument } from '../../lib/happy-dom/parser.js';
import { StyleEngine } from '../../lib/style/computed-style.js';
import { RenderTreeBuilder } from '../../lib/render-tree/index.js';
import { LayoutEngine } from '../../lib/layout/text-layout.js';
import { buildDisplayList } from '../../lib/paint/display-list.js';

const { document, window } = parseHTMLDocument('<body>' + Array.from({ length:200 }, (_, i) =>
  `<section class="card"><p>Text ${i}</p><span>More ${i}</span></section>`).join('') + '</body>');
const sheets = ['body {margin:0} .card {width:500px;padding:3px} p {margin:0}'];
const engine = new StyleEngine().compute(document, sheets), builder = new RenderTreeBuilder();
let measures = 0;
const measureText = (text, style) => { measures++; return text.length * style.fontSize / 2; };
const layout = new LayoutEngine({ measureText }), options = { width:800, viewportHeight:600 };
const tree = builder.build(document, engine);
layout.layout(tree, options);
const before = [...document.querySelectorAll('*')].map(element => [element, engine.get(element)]);
lockdown({ errorTaming:'safe', overrideTaming:'severe', consoleTaming:'unsafe', localeTaming:'unsafe', stackFiltering:'concise', reporting:'none' });
try {
  sheets.push('.unmatched {width:200px}');
  engine.compute(document, sheets);
  assert.equal(engine.incremental, false);
  assert.equal(engine.restyled, before.length);
  for (const [element, style] of before) assert.equal(engine.get(element), style);
  const next = builder.build(document, engine);
  assert.equal(next.root, tree.root);
  measures = 0;
  const result = layout.layout(next, options);
  assert.equal(measures, 0);
  const freshStyle = new StyleEngine().compute(document, sheets);
  const freshTree = new RenderTreeBuilder().build(document, freshStyle);
  const fresh = new LayoutEngine({ measureText }).layout(freshTree, options);
  const actual = buildDisplayList(result, next), expected = buildDisplayList(fresh, freshTree);
  for (const key of ['items', 'hits', 'scrollers', 'extent']) assert.deepEqual(actual[key], expected[key]);
} finally { window.happyDOM.abort(); }

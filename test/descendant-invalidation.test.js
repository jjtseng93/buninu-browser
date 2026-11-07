import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {collectDescendantInvalidations, mergeDescendantTargets, queueDescendantInvalidation, sheetTraits} from '../lib/style/selector-traits.js';

function fixture(source, sheets) {
  const parsed = parseHTMLDocument(source);
  const engine = new StyleEngine().compute(parsed.document, sheets);
  const targets = mergeDescendantTargets(sheets.map(sheetTraits));
  return {...parsed, sheets, engine, targets,
    flush(changes, fullRoots = []) {
      const pending = new Map(), roots = new Set(fullRoots), self = new Set();
      for (const [element, features] of changes) {
        self.add(element);
        queueDescendantInvalidation(pending, roots, element, features, targets);
      }
      collectDescendantInvalidations(pending, roots, self, parsed.document);
      engine.compute(parsed.document, sheets, {}, roots, self);
      return {pending, roots, self};
    },
    check() {
      const reference = new StyleEngine().compute(parsed.document, sheets);
      for (const element of parsed.document.querySelectorAll('*')) {
        expect(engine.get(element)).toEqual(reference.get(element));
        expect(engine.customPropertiesOf(element)).toEqual(reference.customPropertiesOf(element));
        for (const pseudo of ['before','after']) expect(engine.getPseudo(element, pseudo)).toEqual(reference.getPseudo(element, pseudo));
      }
    },
    close() {parsed.window.happyDOM.abort();},
  };
}

test('ancestor class changes restyle possible subjects rather than every descendant', () => {
  const f = fixture('<main><button class="control">control</button>' + '<div><span>unrelated</span></div>'.repeat(500) + '</main>',
    ['main.active .control {opacity:.5}']);
  try {
    const main = f.document.querySelector('main'), control = f.document.querySelector('.control');
    const unchanged = f.document.querySelector('span'), retained = f.engine.get(unchanged);
    main.className = 'active';
    const {roots} = f.flush([[main,['[class','.active']]]);
    expect(roots.size).toBe(0);
    expect(f.engine.restyled).toBe(2);
    expect(f.engine.get(control).opacity).toBe(.5);
    expect(f.engine.get(unchanged)).toBe(retained);
    f.check();
    main.className = '';
    f.flush([[main,['[class','.active']]]);
    expect(f.engine.restyled).toBe(2);
    expect(f.engine.get(control).opacity).toBe(1);
    f.check();
  } finally {f.close();}
});

test('subjects preserve inherited values, explicit inheritance, custom properties and pseudos', () => {
  const f = fixture('<main><section class="control"><span style="width:inherit;color:var(--accent)">child</span></section><aside>other</aside></main>',
    ['main.active .control {color:red;width:100px;--accent:blue} main.active .control::before {content:"ready"}']);
  try {
    const main=f.document.querySelector('main'); main.className='active';
    f.flush([[main,['.active']]]);
    const control=f.document.querySelector('.control');
    expect(f.engine.get(control.firstElementChild)).toMatchObject({width:100,color:'rgba(0, 0, 255, 1)'});
    expect(f.engine.getPseudo(control,'before').content).toBe('ready');
    f.check();
    main.className=''; f.flush([[main,['.active']]]); f.check();
  } finally {f.close();}
});

test('overlapping roots and repeated mutations aggregate target sets before one walk', () => {
  const f=fixture('<main><section><b class="a">a</b><i class="b">b</i></section><b class="a">a</b><i class="b">b</i></main>',
    ['.outer .a {opacity:.2}.inner .b{opacity:.4}']);
  try {
    const main=f.document.querySelector('main'), section=f.document.querySelector('section');
    main.className='outer'; section.className='inner';
    const {pending,self}=f.flush([[main,['.outer']],[section,['.inner']],[main,['.outer']],[section,['.inner']]]);
    expect(pending.size).toBe(2);
    expect(self.size).toBe(5);
    expect(f.engine.get(main.lastElementChild).opacity).toBe(1);
    f.check();
  } finally {f.close();}
});

test('overlapping invalidations inspect each descendant once per batch', () => {
  const {document,window}=parseHTMLDocument('<main><section><b class="a">a</b><i class="b">b</i></section><aside><b class="a">a</b></aside></main>');
  try {
    const main=document.querySelector('main'), section=document.querySelector('section');
    const targets=mergeDescendantTargets([sheetTraits('.outer .a{}.inner .b{}')]);
    const pending=new Map(), roots=new Set(), self=new Set(), reads=new Map();
    for (const element of main.querySelectorAll('*')) {
      const original=element.getAttribute;
      element.getAttribute=function(name){if(name==='id')reads.set(this,(reads.get(this)??0)+1);return original.call(this,name);};
    }
    for(let n=0;n<20;n++) {
      queueDescendantInvalidation(pending,roots,main,['.outer'],targets);
      queueDescendantInvalidation(pending,roots,section,['.inner'],targets);
    }
    collectDescendantInvalidations(pending,roots,self,document);
    expect(reads.size).toBe(5);
    expect([...reads.values()]).toEqual([1,1,1,1,1]);
    expect(self.size).toBe(3);
  } finally {window.happyDOM.abort();}
});

test('full dirty roots cover queued descendants and newly inserted elements', () => {
  const f=fixture('<main><section><b class="a">a</b></section><b class="a">a</b></main>', ['.active .a{opacity:.2}']);
  try {
    const main=f.document.querySelector('main'), section=f.document.querySelector('section');main.className='active';
    section.insertAdjacentHTML('beforeend','<i class="a">new</i>');
    const {self}=f.flush([[main,['.active']],[section,['.active']]], [section]);
    expect(self.has(section.lastElementChild)).toBeFalse();
    expect(f.engine.get(section.lastElementChild).opacity).toBe(.2);
    f.check();
  } finally {f.close();}
});

test('changing an ancestor inherited value still propagates beyond keyed selector subjects', () => {
  const f=fixture('<main><section><b class="a">a</b><span>other</span></section></main>', ['main.active{color:red}.active .a{opacity:.2}']);
  try {
    const main=f.document.querySelector('main');main.className='active';f.flush([[main,['.active']]]);
    expect(f.engine.get(f.document.querySelector('span')).color).toBe('rgba(255, 0, 0, 1)');
    f.check();
  } finally {f.close();}
});

test('id, attribute and type subject keys include HTML and foreign elements', () => {
  const f=fixture('<main><b id="target">id</b><i data-match>attr</i><span>tag</span><svg><rect width="1" height="1"/></svg></main>',
    ['[data-mode] #target{opacity:.1}[data-mode] [data-match]{opacity:.2}[data-mode] span{opacity:.3}[data-mode] rect{opacity:.4}']);
  try {
    const main=f.document.querySelector('main');main.setAttribute('data-mode','on');f.flush([[main,['[data-mode']]]);
    expect(f.engine.restyled).toBe(5);
    expect(f.engine.get(f.document.querySelector('rect')).opacity).toBe(.4);
    f.check();
  } finally {f.close();}
});

test('functional subject alternatives are a conservative union', () => {
  const f=fixture('<main><b class="a">a</b><i class="b">b</i><span>other</span></main>', ['.active :is(.a,.b){opacity:.2}']);
  try {
    const main=f.document.querySelector('main');main.className='active';f.flush([[main,['.active']]]);
    expect(f.engine.restyled).toBe(3);f.check();
  } finally {f.close();}
});

test('universal, complex functional and unknown subjects keep full subtree invalidation', () => {
  for (const sheet of ['.active *{opacity:.2}', ':is(.active .nested) .a{opacity:.2}', '.active :not(.excluded){opacity:.2}', '.active [ns|key]{opacity:.2}']) {
    const f=fixture('<main><section class="nested"><b class="a">a</b><span>other</span></section></main>', [sheet]);
    try {
      const main=f.document.querySelector('main');main.className='active';
      const {roots}=f.flush([[main,['.active']]]);
      expect(roots.has(main)).toBeTrue();f.check();
    } finally {f.close();}
  }
});

test('a universal dependency in any sheet wins without mutating sheet-local sets', () => {
  const one=sheetTraits('.active .a{}'), two=sheetTraits('.active .b{}'), all=sheetTraits('.active *{}');
  const merged=mergeDescendantTargets([one,two]);
  expect([...merged.get('.active')]).toEqual(['.a','.b']);
  expect([...one.descendantTargets.get('.active')]).toEqual(['.a']);
  expect(mergeDescendantTargets([one,all,two]).get('.active')).toBeNull();
  expect(mergeDescendantTargets([all,one]).get('.active')).toBeNull();
});

test('disconnected queued subtrees are ignored and overlapping target lifetimes do not escape their scope', () => {
  const f=fixture('<main><section><b class="a">a</b></section><i class="b">outside</i></main>', ['.outer .a{opacity:.2}.inner .b{opacity:.4}']);
  try {
    const main=f.document.querySelector('main'), section=f.document.querySelector('section'), detached=f.document.createElement('aside');
    main.className='outer';section.className='inner';
    detached.innerHTML='<b class="a">detached</b>';
    const {self}=f.flush([[main,['.outer']],[section,['.inner']],[detached,['.outer']]]);
    expect(self.has(main.lastElementChild)).toBeFalse();
    expect(self.has(detached.firstElementChild)).toBeFalse();f.check();
  } finally {f.close();}
});

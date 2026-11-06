import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

const red = 'rgba(255, 0, 0, 1)', blue = 'rgba(0, 0, 255, 1)', green = 'rgba(0, 128, 0, 1)';

function matchesFresh(engine, document, sheets, elements, scopes = null) {
  const fresh = new StyleEngine().compute(document, sheets, {}, null, null, scopes);
  for (const element of elements) {
    expect(engine.get(element)).toEqual(fresh.get(element));
    expect(engine.customPropertiesOf(element)).toEqual(fresh.customPropertiesOf(element));
    for (const pseudo of ['before', 'after']) expect(engine.getPseudo(element, pseudo)).toEqual(fresh.getPseudo(element, pseudo));
  }
}

test('shared declarations still resolve variables, pending shorthands and inline overrides per element', () => {
  const {document, window} = parseHTMLDocument('<section id="a"><div class="item"></div></section><section id="b"><div class="item"></div></section>');
  try {
    const a = document.getElementById('a'), b = document.getElementById('b');
    const first = a.firstElementChild, second = b.firstElementChild;
    const sheets = [`.item{color:var(--shade);border:var(--edge);padding:var(--pad);overflow:var(--overflow);font-size:var(--size)}
      .item::before{content:"PREFIX";color:var(--shade);padding-left:1em}
      .item::after{content:"SUFFIX";color:var(--shade)}`];
    a.style.cssText = '--shade:red;--edge:2px solid red;--pad:1px 2px;--overflow:hidden scroll;--size:10px';
    b.style.cssText = '--shade:blue;--edge:4px solid blue;--pad:3px 4px;--overflow:scroll hidden;--size:20px';
    const engine = new StyleEngine();
    for (const override of [false, true, false]) {
      first.style.cssText = override ? 'color:green;border-left-width:7px;padding-right:9px;--shade:green' : '';
      engine.compute(document, sheets);
      expect(engine.get(first).color).toBe(override ? green : red);
      expect(engine.get(second).color).toBe(blue);
      expect(engine.get(first).padding).toEqual([1, override ? 9 : 2, 1, 2]);
      expect(engine.get(second).padding).toEqual([3, 4, 3, 4]);
      expect(engine.get(first).borderWidths).toEqual([2, 2, 2, override ? 7 : 2]);
      expect(engine.get(second).borderWidths).toEqual([4, 4, 4, 4]);
      expect(engine.get(first)).toMatchObject({fontSize:10, overflowValueX:'hidden', overflowValueY:'scroll'});
      expect(engine.get(second)).toMatchObject({fontSize:20, overflowValueX:'scroll', overflowValueY:'hidden'});
      expect(engine.getPseudo(first, 'before').color).toBe(override ? green : red);
      expect(engine.getPseudo(second, 'before').padding[3]).toBe(20);
      matchesFresh(engine, document, sheets, [a, b, first, second]);
    }
  } finally {window.happyDOM.close();}
});

test('retained parsed rules pick up changed source order after inserting, removing and reordering sheets', () => {
  const {document, window} = parseHTMLDocument('<div class="item"></div><div class="item"></div>');
  try {
    const elements = [...document.querySelectorAll('.item')], engine = new StyleEngine();
    const a = '.item{color:red;width:11px}', b = '.item{color:blue;width:22px}';
    for (const [sheets, color, width] of [
      [[a, b], blue, 22], [[b, a], red, 11], [[a], red, 11],
      [[a, b, a], red, 11], [[a, b], blue, 22],
    ]) {
      engine.compute(document, sheets);
      for (const element of elements) expect(engine.get(element)).toMatchObject({color, width});
      matchesFresh(engine, document, sheets, elements);
    }
  } finally {window.happyDOM.close();}
});

test('layer rank changes invalidate reused declarations even when rule source order stays unchanged', () => {
  const {document, window} = parseHTMLDocument('<div class="item"></div><div class="item"></div>');
  try {
    const elements = [...document.querySelectorAll('.item')], engine = new StyleEngine();
    const a = '@layer a{.item{color:red;background:red!important}}';
    const b = '@layer b{.item{color:blue;background:blue!important}}';
    for (const [order, color, backgroundColor] of [
      ['a,b', blue, red], ['b,a', red, blue], ['a,b', blue, red],
    ]) {
      const sheets = [`@layer ${order};`, a, b];
      engine.compute(document, sheets);
      for (const element of elements) expect(engine.get(element)).toMatchObject({color, backgroundColor});
      matchesFresh(engine, document, sheets, elements);
    }
  } finally {window.happyDOM.close();}
});

test('host and slotted declarations keep independent encapsulation and inline precedence', () => {
  const {document, window} = parseHTMLDocument('<div id="host"><span class="item" slot="main">LIGHT</span></div><p class="item">ORDINARY</p>');
  try {
    const host = document.getElementById('host'), assigned = host.firstElementChild, ordinary = document.querySelector('p');
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = '<section class="item"><slot name="main"></slot></section>';
    const inner = root.firstElementChild;
    const sheets = ['#host,.item{color:red!important;background:red}'];
    const scoped = ':host,.item,::slotted(.item){color:blue!important;background:blue}';
    const scopes = new Map([[root, [scoped]]]), engine = new StyleEngine();
    for (const inline of ['', 'color:green!important;background:green', '']) {
      host.style.cssText = assigned.style.cssText = ordinary.style.cssText = inline;
      engine.compute(document, sheets, {}, null, null, scopes);
      for (const element of [host, assigned]) expect(engine.get(element)).toMatchObject({color:blue, backgroundColor:inline ? green : red});
      expect(engine.get(inner)).toMatchObject({color:blue, backgroundColor:blue});
      expect(engine.get(ordinary)).toMatchObject({color:inline ? green : red, backgroundColor:inline ? green : red});
      matchesFresh(engine, document, sheets, [host, assigned, inner, ordinary], scopes);
    }
  } finally {window.happyDOM.close();}
});

test('moving a retained shadow root changes its declaration context depth without changing its sheets', () => {
  const {document, window} = parseHTMLDocument('<div id="moved"></div><div id="outer"></div>');
  try {
    const moved = document.getElementById('moved'), outer = document.getElementById('outer');
    const nested = moved.attachShadow({mode:'closed'}), enclosing = outer.attachShadow({mode:'closed'});
    nested.innerHTML = '<span>INNER</span>';enclosing.innerHTML = '<section></section>';
    const outerSheet = '#moved{color:red!important;background:red}';
    const innerSheet = ':host{color:blue!important;background:blue}';
    const sheets = [outerSheet], scopes = new Map([[nested, [innerSheet]], [enclosing, [outerSheet]]]);
    const engine = new StyleEngine();
    for (const parent of [document.body, enclosing.firstElementChild, document.body, enclosing.firstElementChild]) {
      parent.append(moved);
      engine.compute(document, sheets, {}, null, null, scopes);
      expect(engine.get(moved)).toMatchObject({color:blue, backgroundColor:red});
      expect(engine.get(nested.firstElementChild).color).toBe(blue);
      matchesFresh(engine, document, sheets, [moved, outer, nested.firstElementChild, enclosing.firstElementChild], scopes);
    }
  } finally {window.happyDOM.close();}
});

test('a previously unmatched rule remains correct when it first applies after warm cascades', () => {
  const {document, window} = parseHTMLDocument('<div class="item"></div><div class="item"></div>');
  try {
    const elements = [...document.querySelectorAll('.item')], engine = new StyleEngine();
    const sheets = ['.item{color:red}.later{all:initial;color:blue;padding-left:9px}.later::before{content:"LATER";color:green}'];
    engine.compute(document, sheets);
    expect(engine.getPseudo(elements[0], 'before')).toBeNull();
    elements[0].classList.add('later');engine.compute(document, sheets, {}, new Set([elements[0]]));
    expect(engine.get(elements[0]).color).toBe(blue);
    expect(engine.get(elements[0]).padding[3]).toBe(9);
    expect(engine.getPseudo(elements[0], 'before').color).toBe(green);
    expect(engine.get(elements[1]).color).toBe(red);
    matchesFresh(engine, document, sheets, elements);
  } finally {window.happyDOM.close();}
});

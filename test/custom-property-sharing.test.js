import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, resolveVariables} from '../lib/style/computed-style.js';

test('identical custom declarations share inheritance until an effective override', () => {
  const {window, document} = parseHTMLDocument('<main style="--tone:red;--size:10px"><div style="--tone:red"><span></span></div></main>');
  const parent = document.querySelector('main'), child = document.querySelector('div'), leaf = document.querySelector('span');
  const engine = new StyleEngine();
  const sheets = ['span{color:var(--tone);width:var(--size)}'];
  try {
    engine.compute(document, sheets);
    expect(engine.customPropertiesOf(child)).toBe(engine.customPropertiesOf(parent));
    expect(engine.customPropertiesOf(leaf)).toBe(engine.customPropertiesOf(parent));
    child.style.setProperty('--size', '20px');
    engine.compute(document, sheets, {}, new Set([child]));
    expect(engine.customPropertiesOf(child)).not.toBe(engine.customPropertiesOf(parent));
    expect(engine.customPropertiesOf(parent).get('--size')).toBe('10px');
    expect(engine.customPropertiesOf(leaf).get('--size')).toBe('20px');
    expect(engine.get(leaf).width).toBe(20);
    parent.style.setProperty('--tone', 'blue');
    engine.compute(document, sheets, {}, new Set([parent]));
    expect(engine.customPropertiesOf(child).get('--tone')).toBe('red');
    expect(engine.customPropertiesOf(parent).get('--tone')).toBe('blue');
    child.style.removeProperty('--tone');
    engine.compute(document, sheets, {}, new Set([child]));
    expect(engine.customPropertiesOf(leaf).get('--tone')).toBe('blue');
  } finally {window.happyDOM.close();}
});

test('variable resolution keeps caller cycle tracking and does not reuse mutable input maps', () => {
  const variables = new Map([['--x', 'var(--y, red)'], ['--y', 'var(--x, blue)']]);
  const seen = new Set(['--x']);
  expect(resolveVariables(' \t12px\n', variables)).toBe('12px');
  expect(resolveVariables('var(--x, green)', variables, seen)).toBe('green');
  expect([...seen]).toEqual(['--x']);
  expect(resolveVariables('var(--x)', variables)).toBe('blue');
  variables.set('--y', 'orange');
  expect(resolveVariables('var(--x)', variables)).toBe('orange');
  expect(resolveVariables('var(--missing, var(--x))', variables)).toBe('orange');
  // Keep explicit invalid arguments distinct from an omitted cycle set.
  expect(() => resolveVariables('var(--x)', variables, null)).toThrow();
});

test('large inherited custom maps preserve siblings, order and incremental removal', () => {
  const {window, document} = parseHTMLDocument('<main><div id="override"><span></span></div><aside></aside></main>');
  const parent=document.querySelector('main'), child=document.querySelector('div');
  const leaf=document.querySelector('span'), sibling=document.querySelector('aside');
  const engine=new StyleEngine(), sheets=['span,aside {width:var(--v127)}'];
  try {
    for(let i=0;i<256;i++)parent.style.setProperty('--v'+i,i+'px');
    child.style.setProperty('--v127','999px');
    child.style.setProperty('--only-child','yes');
    engine.compute(document,sheets);
    const original=engine.customPropertiesOf(parent), copied=engine.customPropertiesOf(child);
    expect(copied).not.toBe(original);
    expect([...copied.keys()]).toEqual([...original.keys(),'--only-child']);
    expect(copied.get('--v255')).toBe('255px');
    expect(original.has('--only-child')).toBe(false);
    expect(engine.customPropertiesOf(sibling)).toBe(original);
    expect(engine.get(leaf).width).toBe(999);
    expect(engine.get(sibling).width).toBe(127);
    parent.style.setProperty('--v127','888px');
    engine.compute(document,sheets,{},new Set([parent]));
    expect(engine.get(leaf).width).toBe(999);
    expect(engine.get(sibling).width).toBe(888);
    expect(original.get('--v127')).toBe('127px');
    child.style.removeProperty('--v127');
    child.style.removeProperty('--only-child');
    engine.compute(document,sheets,{},new Set([child]));
    expect(engine.get(leaf).width).toBe(888);
    expect(engine.customPropertiesOf(child)).toBe(engine.customPropertiesOf(parent));
  } finally {window.happyDOM.close();}
});

test('isolated variable changes update inherited maps and restyle consumers', () => {
  const {window, document} = parseHTMLDocument('<main><section><b></b><i></i></section><aside><em></em></aside>'
    + '<span></span>'.repeat(200) + '</main>');
  const engine = new StyleEngine(), main = document.querySelector('main');
  const sheets = ['main{--alias:var(--missing,var(--tone));--tone:red}' +
    'b{color:var(--alias)} i::before{content:"x";color:var(--tone)}' +
    'aside{--tone:red} em{color:var(--tone)}'];
  try {
    engine.compute(document,sheets);
    for (const [name,value] of [['--tone','blue'],['--missing','green'],['--missing','']]) {
      main.style.setProperty(name,value);
      engine.compute(document,sheets,{},new Set(),new Set([main]));
      const full = new StyleEngine().compute(document,sheets);
      expect(engine.restyled).toBeLessThan(10);
      for (const node of [main,...main.querySelectorAll('*')]) {
        expect(engine.get(node)).toEqual(full.get(node));
        expect(engine.customPropertiesOf(node)).toEqual(full.customPropertiesOf(node));
        expect(engine.getPseudo(node,'before')).toEqual(full.getPseudo(node,'before'));
      }
    }
    main.style.setProperty('--tone','purple');
    const span=main.querySelector('span');
    span.style.color='orange';
    engine.compute(document,sheets,{},new Set(),new Set([main,span]));
    expect(engine.get(span).color).toBe(new StyleEngine().compute(document,sheets).get(span).color);
  } finally {window.happyDOM.close();}
});

test('reusing a large inheritance map preserves the order and values of sibling overrides', () => {
  const {window, document} = parseHTMLDocument('<main><b></b><b></b><i></i><em></em></main>');
  try {
    const parent = document.querySelector('main');
    parent.style.cssText = Array.from({length: 128}, (_, i) => '--v' + i + ':0').join(';');
    const [first, second, reordered, changed] = parent.children;
    first.style.cssText = second.style.cssText = '--a:1;--b:2';
    reordered.style.cssText = '--b:2;--a:1';
    changed.style.cssText = '--a:1;--b:3';
    const engine = new StyleEngine();
    engine.compute(document, []);
    const vars = element => engine.customPropertiesOf(element);
    expect(vars(first)).toBe(vars(second));
    expect([...vars(first).keys()].slice(-2)).toEqual(['--a', '--b']);
    expect([...vars(reordered).keys()].slice(-2)).toEqual(['--b', '--a']);
    expect(vars(changed).get('--b')).toBe('3');
    expect(vars(second).get('--b')).toBe('2');
    expect(vars(parent).has('--a')).toBe(false);
  } finally {window.happyDOM.close();}
});

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

import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {normalizeTextWrapping} from '../lib/style/css-text-values.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {RendererHost} from '../lib/renderer/host.js';

test('text wrapping validation is shared by CSSOM, stylesheet parsing and supports', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const [name, valid] of [['overflow-wrap','anywhere'],['word-wrap','break-word'],['word-break','keep-all']]) {
      for (const value of ['auto', 'normal keep-all', 'normal, normal', '"normal"', 'normal()', 'var(foo)', 'var(--)', 'var(--x;)']) {
        style.setProperty(name, valid);style.setProperty(name, value);
        expect(style.getPropertyValue(name)).toBe(valid);
        expect(supportsDeclaration(name, value)).toBeFalse();
        const declarations = parseDeclarations(`${name}:${valid};${name}:${value}`);
        expect([...declarations.values()][0].value).toBe(valid);
      }
      expect(supportsDeclaration(name, valid)).toBeTrue();
      expect(supportsDeclaration(name, 'var(--choice)')).toBeTrue();
      expect(normalizeTextWrapping(name, 'INITIAL')).toBe('initial');
    }
    expect(normalizeTextWrapping('overflow-wrap', String.raw`\61 nywhere/**/`)).toBe('anywhere');
    expect(normalizeTextWrapping('word-break', 'KEEP-ALL')).toBe('keep-all');
    expect(normalizeTextWrapping('overflow-wrap', 'any/**/where')).toBeNull();
    expect(normalizeTextWrapping('word-break', '\u00a0normal')).toBeNull();
    expect(normalizeTextWrapping('word-break', 'garbage var(--choice)')).toBe('garbage var(--choice)');
    expect(normalizeTextWrapping('color', 'red')).toBeUndefined();
  } finally {window.happyDOM.close();}
});

test('word-wrap aliases the declaration slot, importance and removal of overflow-wrap', () => {
  const {window, document} = parseHTMLDocument('<div style="word-wrap:break-word!important;overflow-wrap:normal"></div>');
  try {
    const style = document.querySelector('div').style;
    expect(style.cssText).toBe('overflow-wrap: break-word !important;');
    expect(style.wordWrap).toBe('break-word');expect(style.overflowWrap).toBe('break-word');
    expect(style.getPropertyPriority('word-wrap')).toBe('important');
    expect(style.getPropertyPriority('overflow-wrap')).toBe('important');
    expect(style.length).toBe(1);expect(style.item(0)).toBe('overflow-wrap');
    style.wordWrap='anywhere';expect(style.overflowWrap).toBe('anywhere');
    expect(style.removeProperty('overflow-wrap')).toBe('anywhere');expect(style.wordWrap).toBe('');
    style.overflowWrap='normal';expect(style.removeProperty('word-wrap')).toBe('normal');expect(style.overflowWrap).toBe('');
    style.cssText='WORD-WRAP:ANYWHERE';expect(style.cssText).toBe('overflow-wrap: anywhere;');
  } finally {window.happyDOM.close();}
});

test('wrapping aliases share cascade priority and inherited computed values', () => {
  const {window, document} = parseHTMLDocument(`<style>#child{word-wrap:normal;overflow-wrap:break-word!important;word-wrap:anywhere}#unset{word-wrap:unset}#bad{word-wrap:normal;word-wrap:var(--bad);--bad:invalid}</style><div id="parent" style="overflow-wrap:anywhere;word-break:keep-all"><div id="child"></div><div id="unset"></div><div id="bad"></div><div id="valid" style="word-break:var(--choice);--choice:auto-phrase"></div></div>`);
  try {
    const engine = new StyleEngine().compute(document, [document.querySelector('style').textContent]);
    const style = id => engine.get(document.getElementById(id));
    expect(style('child').overflowWrap).toBe('break-word');
    expect(style('unset').overflowWrap).toBe('anywhere');
    expect(style('bad').overflowWrap).toBe('anywhere');
    expect(style('child').wordBreak).toBe('keep-all');
    expect(style('valid').wordBreak).toBe('auto-phrase');
    expect(parseDeclarations('word-wrap:anywhere!important;overflow-wrap:normal').size).toBe(1);
  } finally {window.happyDOM.close();}
});

test('page computed wrapping values and alias mutations remain coherent', async () => {
  const renderer = new RendererHost({timeout:20000});
  try {
    await renderer.start();
    await renderer.call('loadDocument', {url:'https://test.local/',contentType:'text/html',source:'<div style="word-wrap:break-word;word-break:keep-all"></div>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(()=>{const e=document.querySelector('div'),s=getComputedStyle(e);e.style.wordWrap='anywhere';e.style.wordBreak='invalid';return [s.wordWrap,s.overflowWrap,s.wordBreak,e.style.length,CSS.supports('word-wrap','anywhere')];})()`)).toEqual(['anywhere','anywhere','keep-all',2,true]);
  } finally {renderer.close();}
},30000);

import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createStyleSheetBindings} from '../lib/renderer/stylesheet-bindings.js';
import {sheetText, adoptedSheetTexts} from '../lib/renderer/stylesheet-state.js';

function fixture(source, run) {
  const {window, document} = parseHTMLDocument('<style id="sheet"></style><link id="remote" rel="stylesheet">');
  const owner = document.getElementById('sheet');
  owner.textContent = source;
  const sources = new Map();
  const realm = {wrap: node => node, hooks: {touch() {}}};
  const api = createStyleSheetBindings(window, realm, node => {
    if (!node.isConnected) return null;
    if (node === owner) return {text: owner.textContent, href: null, readable: true};
    return sources.get(node) ?? null;
  });
  const createElement = document.createElement;
  let declarationNodes = 0;
  document.createElement = function(name, ...args) {
    if (name === 'span') declarationNodes++;
    return Reflect.apply(createElement, this, [name, ...args]);
  };
  try { run({window, document, owner, sources, api, declarationNodes: () => declarationNodes}); }
  finally { window.happyDOM.abort(); }
}

test('stylesheet enumeration and metadata do not parse declaration blocks', () => fixture('a{color:red}b{width:4px}', f => {
  const sheets = f.api.sheetsFor(f.document);
  expect(sheets.length).toBe(1);
  const sheet = sheets[0];
  expect(sheet).toBe(f.api.sheetFor(f.owner));
  expect([...sheets]).toEqual([sheet]);
  expect(sheets.item(1)).toBeNull();
  expect(sheet.ownerNode).toBe(f.owner);
  expect(sheet.href).toBeNull();
  expect(sheet.type).toBe('text/css');
  expect(sheet.parentStyleSheet).toBeNull();
  expect(sheet.ownerRule).toBeNull();
  sheet.disabled = true;
  sheet.media.mediaText = 'screen, print';
  expect(sheet.disabled).toBe(true);
  expect(sheet.media.item(1)).toBe('print');
  expect(f.declarationNodes()).toBe(0);
  const rules = sheet.cssRules;
  expect(rules.length).toBe(2);
  expect(f.declarationNodes()).toBe(2);
  expect(sheet.cssRules).toBe(rules);
  expect(rules[0]).toBe(rules[0]);
  expect(f.declarationNodes()).toBe(2);
}));

test('cross-origin rules reject access before parsing their private source', () => fixture('', f => {
  const remote = f.document.getElementById('remote');
  f.sources.set(remote, {text: 'body{color:purple}', href: 'https://other.invalid/a.css', readable: false});
  const sheets = f.api.sheetsFor(f.document), sheet = sheets[1];
  expect(sheets.length).toBe(2);
  expect(sheet.href).toBe('https://other.invalid/a.css');
  expect(sheet.ownerNode).toBe(remote);
  for (const action of [() => sheet.cssRules, () => sheet.rules, () => sheet.insertRule('a{}'), () => sheet.deleteRule(0)]) {
    try { action(); throw new Error('expected SecurityError'); }
    catch (error) { expect(error.name).toBe('SecurityError'); }
  }
  expect(f.declarationNodes()).toBe(0);
}));

test('source replacement and removal preserve an unread old sheet snapshot', () => fixture('old{color:red}', f => {
  const list = f.api.sheetsFor(f.document), old = list[0];
  expect(f.declarationNodes()).toBe(0);
  f.owner.textContent = 'new{color:blue}';
  const current = f.api.sheetFor(f.owner);
  expect(current).not.toBe(old);
  expect(list[0]).toBe(current);
  f.owner.remove();
  expect(list.length).toBe(0);
  expect(f.api.sheetFor(f.owner)).toBeNull();
  expect(old.ownerNode).toBe(f.owner);
  expect(old.cssRules[0].selectorText).toBe('old');
  expect(current.cssRules[0].selectorText).toBe('new');
  const rules = old.cssRules, first = rules[0];
  old.insertRule('later{}', 1);
  expect(old.cssRules).toBe(rules);
  expect(rules[0]).toBe(first);
  expect(rules.length).toBe(2);
}));

test('insert and delete before cssRules access include existing source rules', () => fixture('a{color:red}b{width:4px}', f => {
  const sheet = f.api.sheetFor(f.owner);
  sheet.deleteRule(0);
  sheet.insertRule('c{height:7px}', 1);
  const rules = sheet.cssRules;
  expect([...rules].map(rule => rule.selectorText)).toEqual(['b', 'c']);
  expect(rules[1].style.height).toBe('7px');
  expect(rules[0].parentStyleSheet).toBe(sheet);
  expect(sheetText(f.owner, f.owner.textContent)).toMatch(/height:\s*7px/);
  expect(f.owner.textContent).toBe('a{color:red}b{width:4px}');
}));

test('constructed replacement and adoption retain the live loaded rule list', () => fixture('', f => {
  const sheet = new f.api.CSSStyleSheet(), rules = sheet.cssRules;
  f.api.adoption(f.document).replace([sheet]);
  sheet.replaceSync('a{color:red}b{color:blue}');
  expect(sheet.cssRules).toBe(rules);
  expect(rules.length).toBe(2);
  expect(adoptedSheetTexts(f.document)[0]).toMatch(/color:\s*blue/);
  sheet.replaceSync('c{color:green}');
  expect(rules.length).toBe(1);
  expect(rules[0].selectorText).toBe('c');
  rules[0].style.color = 'orange';
  expect(rules[0].style.color).toBe('orange');
  expect(adoptedSheetTexts(f.document)[0]).toContain('orange');
}));

test('pending shorthand edits still publish their source metadata after lazy parse', () => fixture('a{--edge:2px solid red;border:var(--edge);border-left-width:7px}', f => {
  const sheet = f.api.sheetFor(f.owner), rule = sheet.cssRules[0];
  rule.style.borderTopWidth = '9px';
  const published = sheetText(f.owner, f.owner.textContent);
  expect(String(published)).toContain('border-top-width: 9px');
  expect(rule.style.borderLeftWidth).toBe('7px');
  expect(rule.style.parentRule).toBe(rule);
}));

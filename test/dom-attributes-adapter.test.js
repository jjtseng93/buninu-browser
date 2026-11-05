import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

function dom(callback) {
  const { window, document } = parseHTMLDocument('<!doctype html><div id="one" data-x="first"></div>');
  try { return callback(document, window); }
  finally { window.happyDOM.close(); }
}

test('setAttribute and Attr setters retain the node and report the prior value', () => dom((document, window) => {
  const e = document.querySelector('div'), a = e.getAttributeNode('data-x');
  const observer = new window.MutationObserver(() => {});
  observer.observe(e, { attributes: true, attributeOldValue: true });
  e.setAttribute('data-x', 'second');
  a.nodeValue = 'third';
  a.textContent = null;
  a.value = null;
  expect(e.getAttributeNode('data-x')).toBe(a);
  expect(a.nodeName).toBe('data-x');
  expect(e.getAttribute('data-x')).toBe('null');
  expect(observer.takeRecords().map(record => [record.attributeName, record.oldValue, record.attributeNamespace]))
    .toEqual([['data-x','first',null],['data-x','second',null],['data-x','third',null],['data-x','',null]]);
  a.value = 'null';
  expect(observer.takeRecords()).toHaveLength(1);
  observer.disconnect();
}));

test('Attr identity changes only on replacement, which detaches the old node and adopts the new one', () => dom(document => {
  const e = document.querySelector('div'), original = e.getAttributeNode('data-x');
  const other = document.implementation.createDocument(null, 'root');
  const next = other.createAttribute('data-x'); next.value = 'replacement';
  expect(e.setAttributeNode(next)).toBe(original);
  expect(next.ownerDocument).toBe(document);
  expect(original.ownerElement).toBeNull();
  original.value = 'detached';
  expect(e.getAttribute('data-x')).toBe('replacement');
  expect(e.getAttributeNames()).toEqual(['id','data-x']);
  expect(e.setAttributeNode(next)).toBe(next);
  expect(() => document.createElement('p').setAttributeNode(next)).toThrow(DOMException);
  expect(e.removeAttributeNode(next)).toBe(next);
  expect(next.ownerElement).toBeNull();
  expect(() => e.removeAttributeNode(next)).toThrow(DOMException);
}));

test('setAttributeNS changes an existing attribute value without changing its prefix', () => dom((document, window) => {
  const e = document.createElement('div');
  e.setAttributeNS('urn:a', 'p:Item', 'first');
  const a = e.getAttributeNodeNS('urn:a', 'Item');
  const observer = new window.MutationObserver(() => {});
  observer.observe(e, { attributes: true, attributeOldValue: true });
  e.setAttributeNS('urn:a', 'q:Item', 'second');
  expect(a).toBe(e.getAttributeNodeNS('urn:a', 'Item'));
  expect(a.name).toBe('p:Item');
  expect(a.value).toBe('second');
  expect(observer.takeRecords().map(record => [record.attributeName, record.attributeNamespace, record.oldValue]))
    .toEqual([['Item','urn:a','first']]);
  observer.disconnect();
}));

test('namespace keys cannot collide and duplicate qualified names keep list order across replacement', () => dom(document => {
  const e = document.createElement('div');
  for (const [namespace, name, value] of [
    ['urn:a','p:b:c','one'],['urn:a:b','p:c','two'],
    ['urn:z','p:c','three'],[null,'data-x','four']]) e.setAttributeNS(namespace, name, value);
  expect(e.attributes.length).toBe(4);
  expect(e.getAttributeNS('urn:a','b:c')).toBe('one');
  expect(e.getAttributeNS('urn:a:b','c')).toBe('two');
  const replacement = document.createAttributeNS('urn:a','p:c'); replacement.value = 'five';
  e.setAttributeNode(replacement);
  const first = document.createAttributeNS('urn:a:b','q:c'); first.value = 'replacement';
  const old = e.setAttributeNode(first);
  expect(old.ownerElement).toBeNull();
  expect(e.getAttributeNames()).toEqual(['p:b:c','q:c','p:c','data-x','p:c']);
  expect(e.getAttributeNode('p:c').namespaceURI).toBe('urn:z');
  e.removeAttributeNS('urn:z','c');
  expect(e.getAttributeNode('p:c')).toBe(replacement);
  expect([...e.attributes].map(a => a.value)).toEqual(['one','replacement','four','five']);
}));

test('HTML and XML creation preserve the appropriate case and non-namespace colon names', () => dom((document, window) => {
  const xml = new window.XMLDocument();
  xml.append(xml.createElementNS(null, 'root'));
  const html = document.createAttribute('A:Ä');
  expect([html.name,html.localName,html.prefix,html.namespaceURI,html.value]).toEqual(['a:Ä','a:Ä',null,null,'']);
  const a = xml.createAttribute('A:Ä');
  expect([a.name,a.localName,a.prefix,a.namespaceURI,a.ownerDocument===xml]).toEqual(['A:Ä','A:Ä',null,null,true]);
  xml.documentElement.setAttribute('UPPER','yes');
  expect(xml.documentElement.getAttribute('UPPER')).toBe('yes');
  expect(xml.documentElement.getAttribute('upper')).toBeNull();
  const foreign = document.createElementNS('urn:foreign','item');
  foreign.setAttribute('xlink:Href','value');
  expect(foreign.getAttributeNode('xlink:Href').namespaceURI).toBeNull();
  expect(foreign.getAttributeNodeNS('', 'xlink:Href')).toBe(foreign.getAttributeNode('xlink:Href'));
  xml.documentElement.setAttributeNode(a);
  expect(a.cloneNode().ownerDocument).toBe(xml);
}));

test('attribute creation validates current DOM names and reserved namespaces', () => dom(document => {
  for (const name of ['-name','1','a:b:c','a"b',"a'b",'a<b','a\v','é']) {
    expect(document.createAttribute(name).name).toBe(name);
  }
  for (const name of ['', 'a b', 'a\0b', 'a\tb', 'a/b', 'a=b', 'a>b']) {
    expect(() => document.createAttribute(name)).toThrow(DOMException);
  }
  for (const [namespace,name] of [[null,'p:x'],['','p:x'],['urn:a','xml:x'],['urn:a','xmlns'],['urn:a','xmlns:x'],['http://www.w3.org/2000/xmlns/','x']]) {
    try { document.createAttributeNS(namespace,name); throw Error('expected NamespaceError'); }
    catch (error) { expect(error).toBeInstanceOf(DOMException); expect(error.name).toBe('NamespaceError'); }
  }
  const a = document.createAttributeNS('urn:a','p=:b:c');
  expect([a.prefix,a.localName]).toEqual(['p=','b:c']);
  const sentinel = Error('conversion');
  expect(() => document.createAttribute({toString(){throw sentinel}})).toThrow(sentinel);
}));

test('ordinary value writes preserve map indexes and still run id and element hooks', () => dom((document, window) => {
  const e = document.querySelector('div'), map = e[S.attributes];
  const items = map[S.items], byName = map[S.itemsByName], byNS = map[S.itemsByNamespaceURI];
  const a = e.getAttributeNode('id');
  a.value = 'two';
  expect(document.getElementById('one')).toBeNull();
  expect(document.getElementById('two')).toBe(e);
  expect(map[S.items]).toBe(items); expect(map[S.itemsByName]).toBe(byName); expect(map[S.itemsByNamespaceURI]).toBe(byNS);
  const input = document.createElement('input'); input.setAttribute('type','text');
  input.getAttributeNode('type').value = 'checkbox';
  expect(input.type).toBe('checkbox');
}));

test('toggleAttribute respects XML case, validates before use, and only changes attributes as needed', () => dom(document => {
  const xml = document.implementation.createDocument(null,'root'), e = xml.documentElement;
  expect(e.toggleAttribute('UPPER',true)).toBeTrue();
  const a = e.getAttributeNode('UPPER');
  expect(e.toggleAttribute('UPPER',true)).toBeTrue();
  expect(e.getAttributeNode('UPPER')).toBe(a);
  expect(e.toggleAttribute('UPPER',0)).toBeFalse();
  expect(a.ownerElement).toBeNull();
  expect(() => e.toggleAttribute('bad name',false)).toThrow(DOMException);
}));

test('native NamedNodeMap reflection exposes indexes and qualified names, never map keys', () => dom(document => {
  const e = document.querySelector('div'), map = e.attributes;
  e.setAttribute('item', 'method name');
  expect(Object.keys(map)).toEqual(['0','1','2']);
  expect(Object.getOwnPropertyNames(map)).toEqual(['0','1','2','id','data-x']);
  expect(map.id).toBe(e.getAttributeNode('id'));
  expect('data-x' in map).toBeTrue();
  expect(map.item).toBe(Object.getPrototypeOf(map).item);
  expect(map[99]).toBeUndefined();
  expect(Reflect.set(map, '99', 'blocked')).toBeFalse();
  expect(Reflect.deleteProperty(map, 'id')).toBeFalse();
  expect(Reflect.preventExtensions(map)).toBeFalse();
  map.custom = 'expando';
  expect(map.custom).toBe('expando');
  expect(Reflect.deleteProperty(map, 'custom')).toBeTrue();
}));

test('proxied form owners expose one identity and borrowed Element methods accept them', () => dom((document, window) => {
  const form = document.createElement('form'), attr = document.createAttribute('id');
  form.setAttributeNode(attr);
  expect(attr.ownerElement).toBe(form);
  expect(form.attributes.getNamedItem('id')).toBe(attr);
  expect(window.Element.prototype.setAttributeNode.call(form, attr)).toBe(attr);
  attr.value = 'form-owner';
  expect(form.getAttribute('id')).toBe('form-owner');
  expect(window.Element.prototype.removeAttributeNode.call(form, attr)).toBe(attr);
  expect(attr.ownerElement).toBeNull();
}));

test('namespaced attributes notify observers without running null-namespace HTML mutation hooks', () => dom((document, window) => {
  const e = document.createElement('div'); document.body.append(e);
  const handler = () => {};
  e.onclick = handler;
  const observer = new window.MutationObserver(() => {});
  observer.observe(e, {attributes:true,attributeOldValue:true});
  e.setAttributeNS('urn:test','onclick','before');
  e.setAttributeNS('urn:test','onclick','after');
  e.removeAttributeNS('urn:test','onclick');
  expect(e.onclick).toBe(handler);
  expect(observer.takeRecords().map(r=>[r.attributeName,r.attributeNamespace,r.oldValue]))
    .toEqual([['onclick','urn:test',null],['onclick','urn:test','before'],['onclick','urn:test','after']]);
  const option = document.createElement('option');
  option.selected = false;
  option.setAttributeNS('urn:test','selected','');
  expect(option.selected).toBeFalse();
  observer.disconnect();
}));

test('adopting an attached Attr detaches it, reports removal and keeps its internal document', () => dom((document, window) => {
  const target = new window.XMLDocument(), e = document.querySelector('div');
  const a = e.getAttributeNode('data-x');
  const observer = new window.MutationObserver(() => {});
  observer.observe(e, {attributes:true,attributeOldValue:true});
  expect(target.adoptNode(a)).toBe(a);
  expect(a.ownerElement).toBeNull();
  expect(e.getAttributeNode('data-x')).toBeNull();
  expect(a.ownerDocument).toBe(target);
  expect(a[S.ownerDocument]).toBe(target);
  expect(a.cloneNode().ownerDocument).toBe(target);
  expect(observer.takeRecords().map(r=>[r.attributeName,r.oldValue])).toEqual([['data-x','first']]);
  const imported = document.importNode(a);
  expect(imported).not.toBe(a);
  expect(imported.ownerDocument).toBe(document);
  expect(imported.ownerElement).toBeNull();
  observer.disconnect();
}));

test('input type, details open and iframe src reflect only null-namespace attributes', () => dom(document => {
  const input = document.createElement('input'); input.value = 'retained';
  input.setAttributeNS('urn:test','type','file');
  expect(input.type).toBe('text'); expect(input.value).toBe('retained');
  input.type = 'SEARCH';
  expect(input.type).toBe('search');
  expect(input.getAttributeNS(null,'type')).toBe('SEARCH');
  expect(input.getAttributeNS('urn:test','type')).toBe('file');
  input.type = 'unknown'; expect(input.type).toBe('text');
  const details = document.createElement('details'); let toggles = 0;
  details.addEventListener('toggle', () => toggles++);
  details.setAttributeNS('urn:test','open','');
  expect(details.open).toBeFalse(); expect(toggles).toBe(0);
  details.open = true; expect(details.open).toBeTrue();
  details.open = false; expect(details.open).toBeFalse();
  expect(details.hasAttributeNS('urn:test','open')).toBeTrue();
  const iframe = document.createElement('iframe');
  iframe.setAttributeNS('urn:test','src','data:text/html,ignored');
  expect(iframe.src).toBe('');
  iframe.src = 'https://example.com/path';
  expect(iframe.src).toBe('https://example.com/path');
  expect(iframe.getAttributeNS('urn:test','src')).toBe('data:text/html,ignored');
}));

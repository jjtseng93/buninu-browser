import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createElement, createElementNS} from '../lib/happy-dom/element-factories.js';
import {createDetachedDocument, elementTagName} from '../lib/renderer/document-constructor.js';
import {RendererHost} from '../lib/renderer/host.js';

const HTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';

test('active and detached factories choose interfaces using namespace and case-sensitive local name', () => {
  const {window, document} = parseHTMLDocument('');
  try {
    const detached = createDetachedDocument(window);
    for (const owner of [document, detached]) for (const [namespace, name, type] of [
      [HTML, 'p:div', 'HTMLDivElement'], [HTML, 'p:span', 'HTMLSpanElement'],
      [HTML, 'p:DIV', 'HTMLUnknownElement'], [HTML, 'p-x:unknown', 'HTMLUnknownElement'],
      [SVG, 's:svg', 'SVGSVGElement'], [SVG, 's:linearGradient', 'SVGLinearGradientElement'],
      [SVG, 's:lineargradient', 'SVGElement'], ['urn:test', 'p:div', 'Element'],
    ]) {
      const element = owner === document ? createElementNS(owner, namespace, name) : owner.createElementNS(namespace, name);
      const clone = element.cloneNode();
      for (const node of [element, clone]) {
        expect(Object.getPrototypeOf(node)).toBe(window[type].prototype);
        expect([node.namespaceURI, node.prefix, node.localName, node.ownerDocument])
          .toEqual([namespace, name.split(':')[0], name.split(':')[1], owner]);
        expect(elementTagName(node)).toBe(owner === document && namespace === HTML ? name.toUpperCase() : name);
      }
    }
  } finally {window.happyDOM.close();}
});

test('createElement treats colons literally and only HTML documents fold ASCII case', () => {
  const {window, document} = parseHTMLDocument('');
  try {
    for (const contentType of ['text/html', 'application/xml', 'application/xhtml+xml']) {
      const owner = contentType === 'text/html' ? document : createDetachedDocument(window, {contentType});
      const node = createElement(owner, 'P:Div');
      expect([node.localName, node.prefix, node.namespaceURI])
        .toEqual([contentType === 'text/html' ? 'p:div' : 'P:Div', null, contentType === 'application/xml' ? null : HTML]);
      if (contentType !== 'application/xml') expect(node instanceof window.HTMLUnknownElement).toBeTrue();
    }
    expect(createElement(document, '\u0130nput').localName).toBe('\u0130nput');
    expect(createElement(document, 'DIV') instanceof window.HTMLDivElement).toBeTrue();
  } finally {window.happyDOM.close();}
});

test('element API name validation does not constrain parser-created unusual names', () => {
  const {window, document} = parseHTMLDocument('<div id="colon"><http://KSL.com></div><div id="angle"><Home-Schooling</b></div>');
  try {
    for (const id of ['colon', 'angle']) {
      const original = document.getElementById(id);
      expect(original.firstElementChild).not.toBeNull();
      expect(original.cloneNode(true).outerHTML).toBe(original.outerHTML);
    }
    for (const name of ['', '1foo', 'bad name', 'a\0b', 'a/b', 'foo>']) {
      expect(() => createElement(document, name)).toThrow(DOMException);
    }
    for (const [namespace, name, error] of [[null, 'p:div', 'NamespaceError'],
      ['urn:x', 'xml:div', 'NamespaceError'], ['urn:x', 'p:', 'InvalidCharacterError'],
      ['urn:x', ':p', 'InvalidCharacterError'], ['http://www.w3.org/2000/xmlns/', 'p:div', 'NamespaceError']]) {
      try {createElementNS(document, namespace, name); throw Error('must reject');}
      catch (caught) {expect(caught.name).toBe(error);}
    }
    expect([createElementNS(document, '', 'div').namespaceURI, createElementNS(document, undefined, 'div').namespaceURI])
      .toEqual([null, null]);
  } finally {window.happyDOM.close();}
});

test('page prototypes and instanceof agree on prefixed, uppercase and foreign elements', async () => {
  const host = new RendererHost();
  try {
    await host.start();
    await host.call('loadDocument', {url:'https://factories.test/', contentType:'text/html', source:'<p>ordinary</p>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate', `(()=>{
      const html='http://www.w3.org/1999/xhtml';
      return [[html,'p:span','HTMLSpanElement'], [html,'SPAN','HTMLUnknownElement'],
        ['urn:other','SPAN','Element'], [html,'p:div','HTMLDivElement']].map(([ns,name,iface])=>{
        const element=document.createElementNS(ns,name), clone=element.cloneNode();
        return [element,clone].map(node=>[node instanceof globalThis[iface],
          Object.getPrototypeOf(node)===globalThis[iface].prototype,
          node instanceof HTMLSpanElement,node.prefix,node.localName]);
      });
    })()`)).toEqual([
      [[true,true,true,'p','span'], [true,true,true,'p','span']],
      [[true,true,false,null,'SPAN'], [true,true,false,null,'SPAN']],
      [[true,true,false,null,'SPAN'], [true,true,false,null,'SPAN']],
      [[true,true,false,'p','div'], [true,true,false,'p','div']],
    ]);
  } finally {await host.close();}
}, 30_000);

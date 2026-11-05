import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { createDetachedDocument, documentConstructor } from '../lib/renderer/document-constructor.js';
import { RendererHost } from '../lib/renderer/host.js';

const HTML = 'http://www.w3.org/1999/xhtml';

test('detached documents have independent XML metadata and no browsing context', () => {
  const { window } = parseHTMLDocument('<p>active</p>', 'https://page.test/path');
  try {
    const document = createDetachedDocument(window);
    expect(document.childNodes.length).toBe(0);
    expect(document.URL).toBe('about:blank');
    expect(document.documentURI).toBe('about:blank');
    expect(document.defaultView).toBeNull();
    expect(document.location).toBeNull();
    expect(document.contentType).toBe('application/xml');
    expect(document instanceof window.XMLDocument).toBeFalse();
    expect(window.document.URL).toBe('https://page.test/path');
    expect(window.document.body.textContent).toBe('active');
  } finally { window.happyDOM.close(); }
});

test('detached element factories preserve XML case, names, namespaces and node ownership', () => {
  const { window } = parseHTMLDocument('');
  try {
    const document = createDetachedDocument(window);
    for (const name of ['DIV', 'a', 'p:item', 'a=b', 'a:b:c']) {
      const node = document.createElement(name);
      expect([node.localName, node.tagName, node.prefix, node.namespaceURI]).toEqual([name, name, null, null]);
      expect(node.ownerDocument).toBe(document);
    }
    const a = document.createElementNS(HTML, 'p:a');
    expect(a instanceof window.HTMLAnchorElement).toBeTrue();
    expect([a.localName, a.prefix, a.namespaceURI]).toEqual(['a', 'p', HTML]);
    for (const node of [document.createTextNode('x'), document.createComment('x'),
      document.createDocumentFragment(), document.createProcessingInstruction('test','y'), document.createAttribute('a')]) {
      expect(node.ownerDocument).toBe(document);
    }
    for (const name of ['', 'a b', 'a/b', 'a\0b']) expect(() => document.createElement(name)).toThrow(DOMException);
    expect(() => document.createElementNS(null, 'p:a')).toThrow(DOMException);
    expect(() => document.createElementNS('urn:x', 'xml:a')).toThrow(DOMException);
  } finally { window.happyDOM.close(); }
});

test('HTML and XHTML detached factories select HTML elements but differ in casing', () => {
  const { window } = parseHTMLDocument('');
  try {
    const html = createDetachedDocument(window, {contentType:'text/html'});
    const xhtml = createDetachedDocument(window, {xmlDocument:true, contentType:'application/xhtml+xml'});
    expect(html.createElement('DIV').localName).toBe('div');
    expect(xhtml.createElement('DIV').localName).toBe('DIV');
    expect(xhtml.createElement('a').namespaceURI).toBe(HTML);
    expect(xhtml.createAttribute('Mixed').name).toBe('Mixed');
    expect(html.createAttribute('Mixed').name).toBe('mixed');
  } finally { window.happyDOM.close(); }
});

test('cloning detached documents retains interface, type, URL and descendant ownership', () => {
  const { window } = parseHTMLDocument('');
  try {
    const document = createDetachedDocument(window, {xmlDocument:true,contentType:'image/svg+xml'});
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    element.setAttribute('data-x','one');
    element.appendChild(document.createTextNode('text'));
    document.appendChild(element);
    const clone = document.cloneNode(true);
    expect(clone instanceof window.XMLDocument).toBeTrue();
    expect(clone.contentType).toBe('image/svg+xml');
    expect(clone.URL).toBe('about:blank');
    expect(clone.defaultView).toBeNull();
    expect(clone.documentElement).not.toBe(element);
    expect(clone.documentElement.ownerDocument).toBe(clone);
    expect(clone.documentElement.firstChild.ownerDocument).toBe(clone);
    expect(clone.documentElement.attributes[0].ownerDocument).toBe(clone);
    expect(document.cloneNode(false).childNodes.length).toBe(0);
  } finally { window.happyDOM.close(); }
});

test('Document constructor selects its NewTarget prototype once and does not coerce arguments', () => {
  const { window } = parseHTMLDocument('');
  try {
    const prototype = {}, Document = documentConstructor(window, {wrap: node => ({node})}, prototype);
    expect(Document.name).toBe('Document'); expect(Document.length).toBe(0);
    expect(() => Document()).toThrow(TypeError);
    expect(Object.getPrototypeOf(new Document({toString(){throw Error('must not coerce')}}))).toBe(prototype);
    class Derived extends Document {}
    let reads = 0;
    const Target = new Proxy(Derived, {get(target,key,receiver){if(key==='prototype')reads++;return Reflect.get(target,key,receiver)}});
    expect(Object.getPrototypeOf(Reflect.construct(Document, [], Target))).toBe(Derived.prototype);
    expect(reads).toBe(1);
    function Alternate() {} Alternate.prototype = null;
    expect(Object.getPrototypeOf(Reflect.construct(Document, [], Alternate))).toBe(prototype);
  } finally { window.happyDOM.close(); }
});

test('page Document interfaces use wrappers, retain detached identity and share the DOMImplementation factory', async () => {
  const renderer = new RendererHost({ timeout: 20_000 });
  try {
    await renderer.start();
    await renderer.call('loadDocument', {url:'https://page.test/path',contentType:'text/html',source:'<p>active</p>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(()=>{
      const d=new Document(), n=d.createElement('Mixed'), a=d.createAttribute('Attr');
      n.setAttributeNode(a);d.appendChild(n);class Derived extends Document{};
      const xml=document.implementation.createDocument(null,'Root');
      const xhtml=document.implementation.createDocument('http://www.w3.org/1999/xhtml','html');
      const html=document.implementation.createHTMLDocument('test');
      let illegal=false;try{new XMLDocument()}catch(e){illegal=e instanceof TypeError}
      return [d instanceof Node,d instanceof Document,d instanceof XMLDocument,
        Object.getPrototypeOf(d)===Document.prototype,n.constructor===Element,n.ownerDocument===d,
        a.ownerDocument===d,a.ownerElement===n,d.URL,d.documentURI,d.location,d.defaultView,
        d.characterSet,d.charset,d.inputEncoding,d.contentType,d.domain,
        new Derived() instanceof Derived,xml instanceof XMLDocument,
        xml.cloneNode(true) instanceof XMLDocument,xhtml.createElement('a').constructor===HTMLAnchorElement,
        html.contentType,html.URL,html.title,html.createElement('DIV').localName,illegal,
        document.body.textContent,document.URL];
    })()`)).toEqual([true,true,false,true,true,true,true,true,'about:blank','about:blank',null,null,
      'UTF-8','UTF-8','UTF-8','application/xml','page.test',true,true,true,true,'text/html','about:blank','test','div',true,'active','https://page.test/path']);
    expect(await renderer.call('evaluate', `(()=>{
      const d=new Document(), h='http://www.w3.org/1999/xhtml';
      const cases=['text/html','text/xml','application/xhtml+xml','image/svg+xml'];
      const adopted=d.createElementNS(h,'div'), names=[adopted.tagName,adopted.nodeName];
      document.body.appendChild(adopted);names.push(adopted.tagName,adopted.nodeName,adopted.ownerDocument===document);
      d.appendChild(adopted);names.push(adopted.tagName,adopted.nodeName,adopted.ownerDocument===d);
      return [d.createElementNS(h,'p:a').constructor===HTMLAnchorElement,
        d.createElementNS(h,'DIV').constructor===HTMLUnknownElement,names,
        cases.map(type=>{const parsed=new DOMParser().parseFromString('<root/>',type);
          return [parsed.contentType,parsed.URL,parsed.defaultView,parsed instanceof XMLDocument,
            parsed.createElement('a').namespaceURI,parsed.createTextNode('x').ownerDocument===parsed];})];
    })()`)).toEqual([true,true,['div','div','DIV','DIV',true,'div','div',true],[
      ['text/html','https://page.test/path',null,false,HTML,true],
      ['text/xml','https://page.test/path',null,true,null,true],
      ['application/xhtml+xml','https://page.test/path',null,true,HTML,true],
      ['image/svg+xml','https://page.test/path',null,true,null,true],
    ]]);
  } finally { await renderer.close(); }
}, 30_000);

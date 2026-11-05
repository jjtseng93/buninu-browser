import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import XMLDocument from '../../vendor/happy-dom/packages/happy-dom/src/nodes/xml-document/XMLDocument.ts';

const HTML = 'http://www.w3.org/1999/xhtml';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const origins = new WeakMap();
const encodings = new WeakMap();
// Encoding's canonical names (TextDecoder.encoding deliberately lowercases).
const encodingNames = new Map(('UTF-8 IBM866 ISO-8859-2 ISO-8859-3 ISO-8859-4 ISO-8859-5 ISO-8859-6 ISO-8859-7 ISO-8859-8 ISO-8859-8-I ISO-8859-10 ISO-8859-13 ISO-8859-14 ISO-8859-15 ISO-8859-16 KOI8-R KOI8-U GBK Big5 EUC-JP ISO-2022-JP Shift_JIS EUC-KR UTF-16BE UTF-16LE')
  .split(' ').map(name => [name.toLowerCase(), name]));
const elementName = /^(?:[A-Za-z][^\0\t\n\f\r />]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9\-.:_\u0080-\u{10FFFF}]*)$/u;
const prefixName = /^[^\0\t\n\f\r />]+$/;
const lower = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const upper = value => value.replace(/[a-z]/g, letter => letter.toUpperCase());

export function documentOriginURL(document) { return origins.get(document) ?? document.URL; }
export function documentEncoding(document) { return encodings.get(document) ?? 'UTF-8'; }
export function setDocumentEncoding(document, encoding) {
  encodings.set(document, encodingNames.get(encoding.toLowerCase()) ?? encoding);
}
export function isXMLDocument(document) { return document instanceof XMLDocument; }
export function elementTagName(element) {
  const name = element.prefix === null ? element.localName : `${element.prefix}:${element.localName}`;
  return element.namespaceURI === HTML && element.ownerDocument?.contentType === 'text/html' ? upper(name) : name;
}

/** An inert document uses the existing native window's node factories, never
 * a new page, evaluator or browsing context. Its URL and type are independent
 * from that window's active document, as required by DOM's document factories. */
export function createDetachedDocument(window, {
  xmlDocument = false, contentType = 'application/xml', url = 'about:blank',
  sourceDocument = window.document,
} = {}) {
  const document = xmlDocument ? new window.XMLDocument() : new window.Document();
  return prepareDetachedDocument(document, { contentType, url, sourceDocument });
}

/** DOMParser already built its tree in an inert parser window. Give that
 * document the same independent factories without creating a second tree. */
export function prepareDetachedDocument(document, {
  contentType = document.contentType, url = 'about:blank', sourceDocument = document[S.window].document,
  active = false,
} = {}) {
  const window = document[S.window], xmlDocument = isXMLDocument(document);
  document[S.contentType] = contentType;
  document[S.defaultView] = active ? window : null;
  origins.set(document, documentOriginURL(sourceDocument));
  if (!active) Object.defineProperties(document, {
    URL: { value: url, configurable: true },
    documentURI: { value: url, configurable: true },
    location: { value: null, configurable: true },
  });
  const nativeElement = document.createElementNS;
  const createElement = (namespace, localName, prefix, options) => {
    // Select the native element interface using its local name, not its prefix.
    const element = nativeElement.call(document, namespace, localName, options);
    element[S.ownerDocument] = document;
    element[S.localName] = localName;
    element[S.prefix] = prefix;
    const qualifiedName = prefix === null ? localName : `${prefix}:${localName}`;
    // Happy DOM uses this key internally for HTML class behavior. The public
    // bindings derive tagName/nodeName from the current document, so adoption
    // into HTML or XML changes casing without changing the native class key.
    element[S.tagName] = namespace === HTML ? upper(qualifiedName) : qualifiedName;
    return element;
  };
  document.createElement = function(name, options) {
    if (!elementName.test(name)) throw new DOMException('Invalid element name', 'InvalidCharacterError');
    const html = contentType === 'text/html';
    return createElement(html || contentType === 'application/xhtml+xml' ? HTML : null,
      html ? lower(name) : name, null, options);
  };
  document.createElementNS = function(namespace, name, options) {
    namespace = namespace == null || namespace === '' ? null : namespace;
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? null : name.slice(0, colon);
    const localName = colon < 0 ? name : name.slice(colon + 1);
    if (!elementName.test(localName) || (prefix !== null && !prefixName.test(prefix))) {
      throw new DOMException('Invalid qualified element name', 'InvalidCharacterError');
    }
    if ((prefix !== null && namespace === null) || (prefix === 'xml' && namespace !== XML)
      || ((name === 'xmlns' || prefix === 'xmlns') && namespace !== XMLNS)
      || (namespace === XMLNS && name !== 'xmlns' && prefix !== 'xmlns')) {
      throw new DOMException('Invalid element namespace', 'NamespaceError');
    }
    return createElement(namespace, localName, prefix, options);
  };
  // Happy DOM's window-bound constructors default these nodes to the active
  // document. Override that default before a newly created node is exposed.
  for (const name of ['createTextNode', 'createComment', 'createDocumentFragment', 'createProcessingInstruction']) {
    const native = document[name];
    document[name] = function(...args) {
      const node = native.apply(document, args);
      node[S.ownerDocument] = document;
      return node;
    };
  }
  document[S.cloneNode] = function(deep = false) {
    const clone = createDetachedDocument(window, { xmlDocument, contentType, url: active ? document.URL : url, sourceDocument: document });
    setDocumentEncoding(clone, documentEncoding(document));
    if (deep) for (const child of document.childNodes) {
      const copy = child.cloneNode(true), pending = [copy];
      while (pending.length) {
        const node = pending.pop();
        node[S.ownerDocument] = clone;
        for (const attribute of node.attributes ?? []) attribute[S.ownerDocument] = clone;
        for (const child of node.childNodes) pending.push(child);
      }
      clone.appendChild(copy);
    }
    return clone;
  };
  return document;
}

/** An XML navigation owns the same inert parser window used by HTML. Replace
 * its initial blank document before installing factories and page bindings;
 * its URL/location remain live properties of that window. */
export function prepareActiveDocument(document, {contentType, url, referrer = ''}) {
  const window = document[S.window];
  window.document = document;
  prepareDetachedDocument(document, {contentType, url, sourceDocument:document, active:true});
  document[S.referrer] = referrer;
  // HTML's document accessors use direct HTML-namespace children, even in an
  // XML document. A foreign/uppercase/nested body is not document.body.
  const htmlChild = names => {
    const root = document.documentElement;
    if (root?.namespaceURI !== HTML || root.localName !== 'html') return null;
    return [...root.children].find(child => child.namespaceURI === HTML && names.includes(child.localName)) ?? null;
  };
  Object.defineProperties(document, {
    head: {get:() => htmlChild(['head']), configurable:true},
    body: {get:() => htmlChild(['body', 'frameset']), configurable:true},
  });
  const pending = [...document.childNodes];
  while (pending.length) {
    const node = pending.pop();
    node[S.ownerDocument] = document;
    for (const attribute of node.attributes ?? []) attribute[S.ownerDocument] = document;
    for (const child of node.childNodes) pending.push(child);
    if (node.content?.nodeType === 11) pending.push(node.content);
  }
  return document;
}

export function documentConstructor(window, realm, prototype, global = () => globalThis) {
  function Document() { throw new (global().TypeError)('Document requires new'); }
  Object.defineProperty(Document, 'prototype', { value: prototype, writable: false });
  return new Proxy(Document, { construct(_target, _args, newTarget) {
    const selected = newTarget.prototype;
    const result = realm.wrap(createDetachedDocument(window));
    Object.setPrototypeOf(result, selected !== null && (typeof selected === 'object' || typeof selected === 'function')
      ? selected : prototype);
    return result;
  } });
}

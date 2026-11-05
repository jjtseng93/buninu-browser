import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const HTML = 'http://www.w3.org/1999/xhtml';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const elementName = /^(?:[A-Za-z][^\0\t\n\f\r />]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9\-.:_\u0080-\u{10FFFF}]*)$/u;
const prefixName = /^[^\0\t\n\f\r />]+$/;
const lower = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const upper = value => value.replace(/[a-z]/g, letter => letter.toUpperCase());
const nativeElement = Document.prototype.createElementNS;
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
  return String(value);
}

// The interface is selected by namespace and local name. A prefix is metadata,
// not part of the HTML/SVG interface lookup. Preserve the native constructor
// path so specialized element initialization still runs exactly once.
function create(document, namespace, localName, prefix, options) {
  const element = nativeElement.call(document, namespace, localName, options);
  element[S.ownerDocument] = document;
  element[S.localName] = localName;
  element[S.prefix] = prefix;
  const qualifiedName = prefix === null ? localName : `${prefix}:${localName}`;
  // Public bindings derive casing from the current document (including after
  // adoption); this is the native key used by existing HTML element behavior.
  element[S.tagName] = namespace === HTML ? upper(qualifiedName) : qualifiedName;
  return element;
}

export function createElement(document, name, options) {
  name = string(name);
  if (!elementName.test(name)) throw new DOMException('Invalid element name', 'InvalidCharacterError');
  const html = document.contentType === 'text/html';
  return create(document, html || document.contentType === 'application/xhtml+xml' ? HTML : null,
    html ? lower(name) : name, null, options);
}

export function createElementNS(document, namespace, name, options) {
  namespace = namespace == null ? null : string(namespace) || null;
  name = string(name);
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
  return create(document, namespace, localName, prefix, options);
}

// Detached and active XML documents use these factories internally too.
// Ordinary HTML parsing keeps its separate, deliberately permissive parser
// creation path: parser-produced names need not be valid DOM API arguments.
export function installElementFactories(document) {
  document.createElement = (name, options) => createElement(document, name, options);
  document.createElementNS = (namespace, name, options) => createElementNS(document, namespace, name, options);
}

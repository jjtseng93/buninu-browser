import XMLParser from '../../vendor/happy-dom/packages/happy-dom/src/xml-parser/XMLParser.ts';
import XMLEncodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/utilities/XMLEncodeUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {prepareDetachedDocument, setDocumentEncoding} from './document-constructor.js';
import {decodeXHRResponse, xhrResponseEncoding} from './xhr-response.js';

const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const HTML = 'http://www.w3.org/1999/xhtml';

// A private parser result, not a search for <parsererror>: that is also a legal
// element in an author's XML. Native parseError covers EOF and namespace errors
// that do not consistently populate the parser's errorMessage field.
class ResponseXMLParser extends XMLParser {
  valid = true;
  parseError() { this.valid = false; }
  invalidNamespace() { this.valid = false; this.readState = 'error'; }
  parseProcessingInstruction(text) {
    // XML permits either quote and whitespace around '=' in its declaration.
    // Keep the existing tree builder, whose declaration matcher is narrower.
    if (/^xml\s/.test(text)) text = text.replace(/\b(version|encoding|standalone)\s*=\s*(['"])([^'"]*)\2/g, '$1="$3"');
    return super.parseProcessingInstruction(text);
  }
  parseEndOfStartTag(source, selfClosed) {
    const namespaces = this.namespacePrefixStack.at(-1);
    namespaces.set('xml', XML);
    const attributes = [...source.matchAll(/([^\s=<>"']+)\s*=\s*(["'])(.*?)\2/gs)].map(match => ({
      name:match[1], value:XMLEncodeUtility.decodeXMLAttributeValue(match[3].replace(/[\t\r\n]/g, ' ')),
    }));
    // Resolve all declarations first, regardless of their source order. Reject
    // namespace well-formedness errors before the native attribute map can
    // merge duplicate expanded names or assign its limited HTML namespaces.
    let defaultNamespace;
    for (const {name, value} of attributes) if (name === 'xmlns' || name.startsWith('xmlns:')) {
      const prefix = name === 'xmlns' ? '' : name.slice(6);
      if (prefix === 'xmlns' || value === XMLNS || prefix === 'xml' && value !== XML
        || prefix !== 'xml' && value === XML || prefix && !value) {
        this.invalidNamespace(); return;
      }
      namespaces.set(prefix, value);
      if (prefix === '') defaultNamespace = value;
    }
    const expanded = new Set();
    for (const attribute of attributes) {
      const parts = attribute.name.split(':');
      if (parts.length > 2 || parts.some(part => !part)) { this.invalidNamespace(); return; }
      const prefix = parts.length === 2 ? parts[0] : null, local = parts.at(-1);
      const namespace = attribute.name === 'xmlns' || prefix === 'xmlns' ? XMLNS
        : prefix ? namespaces.get(prefix) : null;
      if (prefix && !namespace) { this.invalidNamespace(); return; }
      const key = `${namespace ?? ''}\0${local}`;
      if (expanded.has(key)) { this.invalidNamespace(); return; }
      expanded.add(key);
      Object.assign(attribute, {namespace, prefix, local});
    }
    if (this.nextElement?.prefix === 'xmlns') { this.invalidNamespace(); return; }
    if (this.nextElement?.prefix === 'xml') this.nextElement[S.namespaceURI] = XML;
    const parent = this.currentNode;
    super.parseEndOfStartTag(source, selfClosed);
    if (this.readState !== 'any') return;
    const element = selfClosed ? (parent.namespaceURI === HTML && parent.localName === 'template'
      ? parent.content.lastChild : parent.lastChild) : this.currentNode;
    if (element?.[S.namespaceURI] === '') element[S.namespaceURI] = null;
    for (const {name, namespace, prefix, local} of attributes) {
      const attribute = element?.getAttributeNode(name);
      if (!attribute) continue;
      element.removeAttributeNode(attribute);
      attribute[S.namespaceURI] = namespace;
      attribute[S.prefix] = prefix;
      attribute[S.localName] = local;
      element.setAttributeNodeNS(attribute);
    }
    // Native XMLParser pushes the prefix map even for self-closing elements.
    // Its default-namespace stack also needs explicit empty/default bindings
    // on prefixed elements, which do not change that element's own namespace.
    if (selfClosed) this.namespacePrefixStack.pop();
    else if (defaultNamespace !== undefined) this.defaultNamespaceStack[this.defaultNamespaceStack.length - 1] = defaultNamespace;
  }
}

export function isXMLMimeType(type) {
  return type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml');
}

/** XHR's detached document response. The caller owns/reuses its inert parser
 * window and closes it on page disposal; no page, evaluator or resource loader
 * is created here. Bun's optional XML validator never loads external entities
 * and bounds internal entity expansion. Older runtimes retain native parser
 * validation plus the XML character check, without a second custom parser. */
export function xhrDocumentResponse({bytes, responseType, metadata, url, sourceDocument, window}) {
  const xml = isXMLMimeType(metadata.essence);
  if (!xml && (metadata.essence !== 'text/html' || responseType !== 'document')) return null;
  // An absent response body is represented separately by the caller. Empty
  // XML fails parsing; an empty HTML response still creates an HTML document.
  let parsed;
  if (xml) {
    try {
      const text = decodeXHRResponse(bytes, 'document', metadata, {fatal:true});
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) return null;
      if (typeof Bun.XML?.parse === 'function') Bun.XML.parse(text);
      const parser = new ResponseXMLParser(window);
      parsed = parser.parse(text);
      if (!parser.valid) return null;
    } catch { return null; }
  } else parsed = new window.DOMParser().parseFromString(decodeXHRResponse(bytes, 'document', metadata), 'text/html');
  prepareDetachedDocument(parsed, {contentType:metadata.essence, url, sourceDocument});
  parsed[S.readyState] = 'complete';
  setDocumentEncoding(parsed, xhrResponseEncoding(bytes, 'document', metadata));
  return parsed;
}

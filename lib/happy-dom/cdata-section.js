import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import Text from '../../vendor/happy-dom/packages/happy-dom/src/nodes/text/Text.ts';
import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import DocumentFragment from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document-fragment/DocumentFragment.ts';
import NodeFactory from '../../vendor/happy-dom/packages/happy-dom/src/nodes/NodeFactory.ts';
import NodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/NodeUtility.ts';
import XMLParser from '../../vendor/happy-dom/packages/happy-dom/src/xml-parser/XMLParser.ts';
import HTMLSerializer from '../../vendor/happy-dom/packages/happy-dom/src/html-serializer/HTMLSerializer.ts';
import XMLEncodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/utilities/XMLEncodeUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// DOM CDATASection is a Text subtype; normalization still merges only
// exclusive Text nodes. Native splitText correctly creates a regular Text.
class CDATASection extends Text {
  [S.nodeType] = 4;
  get nodeName() { return '#cdata-section'; }
  toString() { return '[object CDATASection]'; }
  [S.appendChild]() { throw new DOMException('CharacterData cannot contain children', 'HierarchyRequestError'); }
  [S.insertBefore]() { throw new DOMException('CharacterData cannot contain children', 'HierarchyRequestError'); }
}

export function createCDATASection(document, data, DOMExceptionConstructor = DOMException) {
  if (document[S.contentType] === 'text/html')
    throw new DOMExceptionConstructor('CDATA sections are not supported in HTML documents', 'NotSupportedError');
  if (data.includes(']]>'))
    throw new DOMExceptionConstructor('CDATA data must not contain ]]>', 'InvalidCharacterError');
  const node = NodeFactory.createNode(document, CDATASection, data);
  node[S.ownerDocument] = document;
  return node;
}
Document.prototype.createCDATASection = function(data) {
  if (!(this instanceof Document)) throw new TypeError('Illegal invocation');
  if (!arguments.length) throw new TypeError('createCDATASection requires an argument');
  if (typeof data === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
  return createCDATASection(this, String(data));
};
const adoptNode = Document.prototype.adoptNode;
Document.prototype.adoptNode = function(node) {
  // Native adoption installs an own ownerDocument only on the subtree root.
  // Keep the internal owner of the entire subtree in sync: inserting the Text
  // returned by CDATA.splitText inherits its parent's internal owner too.
  let result;
  if (node instanceof CDATASection) {
    node[S.parentNode]?.removeChild(node);
    node[S.ownerDocument] = this;
    result = node;
  } else result = adoptNode.call(this, node);
  const pending = [result];
  while (pending.length) {
    const child = pending.pop();
    child[S.ownerDocument] = this;
    for (const attribute of child.attributes ?? []) attribute[S.ownerDocument] = this;
    for (const descendant of child[S.nodeArray]) pending.push(descendant);
  }
  return result;
};
for (const method of [S.appendChild, S.insertBefore]) {
  const original = Document.prototype[method];
  Document.prototype[method] = function(node, ...args) {
    if (node?.[S.nodeType] === 4 || node?.[S.nodeType] === 11 && node[S.nodeArray].some(child => child[S.nodeType] === 4))
      throw new DOMException('CDATA cannot be inserted into a Document', 'HierarchyRequestError');
    return original.call(this, node, ...args);
  };
}

const isText = node => node?.[S.nodeType] === 3 || node?.[S.nodeType] === 4;
Object.defineProperty(Text.prototype, 'wholeText', {
  configurable: true, get() {
    const siblings = this[S.parentNode]?.[S.nodeArray];
    if (!siblings) return this[S.data];
    let start = siblings.indexOf(this), end = start + 1;
    while (start > 0 && isText(siblings[start - 1])) start--;
    while (end < siblings.length && isText(siblings[end])) end++;
    return siblings.slice(start, end).map(node => node[S.data]).join('');
  },
});
for (const prototype of [Element.prototype, DocumentFragment.prototype]) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'textContent');
  Object.defineProperty(prototype, 'textContent', {...descriptor, get() {
    let text = '';
    for (const node of this[S.nodeArray]) {
      if (node[S.nodeType] === 1 || isText(node)) text += node.textContent;
    }
    return text;
  }});
}
const nodeLength = NodeUtility.getNodeLength;
NodeUtility.getNodeLength = node => node[S.nodeType] === 4 ? node[S.data].length : nodeLength(node);
const equalNode = NodeUtility.isEqualNode;
NodeUtility.isEqualNode = (a, b) => a[S.nodeType] === 4
  ? b[S.nodeType] === 4 && a[S.data] === b[S.data] : equalNode(a, b);

// Reuse the existing XML parser's declaration state. It has already consumed
// '<!' and emits preceding Text before this hook. Jump past the CDATA closing
// delimiter so markup/entities within it are never parsed or decoded.
const sources = new WeakMap();
const parse = XMLParser.prototype.parse;
XMLParser.prototype.parse = function(source) {
  source = String(source);
  sources.set(this, source);
  try { return parse.call(this, source); }
  finally { sources.delete(this); }
};
const declaration = XMLParser.prototype.parseDocumentType;
XMLParser.prototype.parseDocumentType = function(text) {
  const source = sources.get(this);
  if (!source?.startsWith('[CDATA[', this.startTagIndex)) return declaration.call(this, text);
  const start = this.startTagIndex + 7, end = source.indexOf(']]>', start);
  if (end < 0 || this.currentNode === this.rootNode) {
    this.errorMessage = end < 0 ? 'CDATA section not terminated' : 'CDATA outside the document element';
    this.errorIndex = this.startTagIndex;
    this.readState = 'error';
    return;
  }
  const data = source.slice(start, end).replace(/\r\n?/g, '\n');
  this.currentNode[S.appendChild](createCDATASection(this.rootNode, data), true);
  this.markupRegExp.lastIndex = end + 3;
  this.readState = 'any';
};

// HTML's fragment serialization treats CDATA as text (XMLSerializer's XML
// CDATA syntax is a separate path). Keep raw-text handling namespace-aware.
const serializeHTML = HTMLSerializer.prototype.serializeToString;
const rawText = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
HTMLSerializer.prototype.serializeToString = function(node) {
  if (node[S.nodeType] !== 4) return serializeHTML.call(this, node);
  const parent = node.parentElement;
  return parent?.namespaceURI === 'http://www.w3.org/1999/xhtml' && rawText.has(parent.localName)
    ? node[S.data] : XMLEncodeUtility.encodeTextContent(node[S.data]);
};

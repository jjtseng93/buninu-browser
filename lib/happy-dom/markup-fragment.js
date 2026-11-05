import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import NodeFactory from '../../vendor/happy-dom/packages/happy-dom/src/nodes/NodeFactory.ts';
import HTMLParser from '../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts';
import XMLEncodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/utilities/XMLEncodeUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {parseXMLTree} from './xml-tree-parser.js';
import {locateNamespace} from './node-queries.js';
import {replaceNode} from './node-replacement.js';
import {characterDataString} from './node-text.js';
import {parseHTMLWithShadowRoots} from './dom-parsing.js';

const HTML = 'http://www.w3.org/1999/xhtml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const escapeAttribute = value => value.replace(/[&"<\t\r\n]/g, c => ({'&':'&amp;', '"':'&quot;', '<':'&lt;', '\t':'&#9;', '\r':'&#13;', '\n':'&#10;'}[c]));

function xmlFragment(context, markup, fragment) {
  // XML fragment parsing inherits the DOM's in-scope namespaces, including
  // prefixes represented by element names without an explicit xmlns Attr.
  const prefixes = new Set(['']);
  for (let node = context; node?.nodeType === 1; node = node.parentElement) {
    if (node.prefix) prefixes.add(node.prefix);
    for (const attr of node.attributes) if (attr.namespaceURI === XMLNS)
      prefixes.add(attr.prefix === 'xmlns' ? attr.localName : '');
  }
  let declarations = '';
  for (const prefix of prefixes) {
    const namespace = locateNamespace(context, prefix || null);
    if (namespace !== null) declarations += ` xmlns${prefix ? ':' + prefix : ''}="${escapeAttribute(namespace)}"`;
  }
  const name = context.prefix ? `${context.prefix}:${context.localName}` : context.localName;
  const result = parseXMLTree(context.ownerDocument[S.window], `<${name}${declarations}>${markup}</${name}>`);
  const root = result.document?.documentElement;
  if (!result.valid || !root || result.document.childNodes.length !== 1)
    throw new DOMException('The markup is not a well-formed XML fragment', 'SyntaxError');
  const children = root.namespaceURI === HTML && root.localName === 'template' ? root.content : root;
  while (children.firstChild) fragment.appendChild(children.firstChild);
}

/** Parse into detached nodes, using the insertion context without touching
 * its live children. Fragment scripts remain inert, like innerHTML scripts.
 * This shares the existing HTML/XML tree builders and their node factories. */
export function parseMarkupFragment(context, markup, {declarative = false} = {}) {
  const document = context.ownerDocument, fragment = document.createDocumentFragment();
  if (!declarative && document.contentType !== 'text/html') {
    xmlFragment(context, markup, fragment);
    return fragment;
  }
  // Fragment tokenizer state depends on its context even before the first
  // token; the document parser normally enters these states from a start tag.
  if (context.namespaceURI === HTML && ['title', 'textarea', 'style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'].includes(context.localName)) {
    let text = markup.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
    if (context.localName === 'title' || context.localName === 'textarea') text = XMLEncodeUtility.decodeHTMLEntities(text);
    if (text) fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  // A fragment parser needs the context's tag/namespace, not a DOM clone:
  // cloning would run a custom constructor and copy a potentially huge
  // clonable shadow tree even though this temporary root is never exposed.
  const options = {isTemplateDocumentFragment: context.namespaceURI === HTML && context.localName === 'template'};
  const constructor = options.isTemplateDocumentFragment ? 'HTMLTemplateElement'
    : context.namespaceURI === HTML && context.localName === 'html' ? 'HTMLHtmlElement' : 'Element';
  const temporary = NodeFactory.createNode(document, document[S.window][constructor]);
  for (const key of [S.tagName,S.localName,S.namespaceURI,S.prefix,S.ownerDocument]) temporary[key] = context[key];
  if (declarative) parseHTMLWithShadowRoots(document[S.window], markup, temporary, options);
  else new HTMLParser(document[S.window], options).parse(markup, temporary);
  const children = temporary.namespaceURI === HTML && temporary.localName === 'template' ? temporary.content : temporary;
  while (children.firstChild) fragment.appendChild(children.firstChild);
  return fragment;
}

/** The input is already converted, so a conversion callback may have moved
 * the receiver; read its current parent only after that callback finishes. */
export function replaceOuterHTML(element, markup) {
  const parent = element.parentNode;
  if (!parent) return null;
  if (parent.nodeType === 9) throw new DOMException('A document element cannot be replaced using outerHTML', 'NoModificationAllowedError');
  const context = parent.nodeType === 11 ? element.ownerDocument.createElementNS(HTML, 'body') : parent;
  const fragment = parseMarkupFragment(context, markup);
  replaceNode(parent, fragment, element);
  return parent;
}

const outerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
Object.defineProperty(Element.prototype, 'outerHTML', {...outerHTML, set(value) {
  if (!(this instanceof Element)) throw new TypeError('Illegal invocation');
  replaceOuterHTML(this, characterDataString(value));
}});

import {elementIdMap} from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';

// DOM's namespace algorithms start from an Element context. In particular,
// neither an Attr without an owner nor a Fragment inherits its document's
// namespaces (even the reserved xml/xmlns bindings).
function namespaceElement(node) {
  switch (node.nodeType) {
    case 1: return node;
    case 2: return node.ownerElement;
    case 9: return node.documentElement;
    case 10: case 11: return null;
    default: return node.parentElement;
  }
}

export function locateNamespace(node, prefix) {
  for (let element = namespaceElement(node); element; element = element.parentElement) {
    if (prefix === 'xml') return XML;
    if (prefix === 'xmlns') return XMLNS;
    if (element.namespaceURI !== null && element.prefix === prefix) return element.namespaceURI;
    for (const attribute of element.attributes) {
      if (attribute.namespaceURI !== XMLNS) continue;
      if (attribute.prefix === 'xmlns' && attribute.localName === prefix ||
          prefix === null && attribute.prefix === null && attribute.localName === 'xmlns')
        return attribute.value || null;
    }
  }
  return null;
}

export function locateNamespacePrefix(node, namespace) {
  if (namespace === null || namespace === '') return null;
  for (let element = namespaceElement(node); element; element = element.parentElement) {
    if (element.namespaceURI === namespace && element.prefix !== null) return element.prefix;
    for (const attribute of element.attributes) {
      if (attribute.namespaceURI === XMLNS && attribute.prefix === 'xmlns' && attribute.value === namespace)
        return attribute.localName;
    }
  }
  return null;
}

// Exact DOMString lookup, not a selector: IDs can contain NUL, unmatched
// surrogates or CSS syntax. The document index remains O(1) for unique IDs;
// only duplicate candidates require a tree-order comparison. Disconnected or
// shadow-tree entries cannot be returned, even while an index is being updated.
export function elementById(root, id) {
  if (id === '') return null;
  if (root.nodeType === 9) {
    const candidates = root[elementIdMap].get(id)?.elements;
    if (!candidates) return null;
    let first = null;
    for (const element of candidates) {
      if (!element.isConnected || element.getRootNode() !== root || element.getAttributeNS(null, 'id') !== id) continue;
      if (!first || first.compareDocumentPosition(element) & 2) first = element;
    }
    return first;
  }
  // Walk only the ordinary descendant tree; neither shadow nor template
  // contents are children of their host. Avoid recursion on deep fragments.
  let element = root.firstElementChild;
  while (element) {
    if (element.getAttributeNS(null, 'id') === id) return element;
    if (element.firstElementChild) {
      element = element.firstElementChild;
      continue;
    }
    while (element && element !== root && !element.nextElementSibling) element = element.parentNode;
    if (!element || element === root) break;
    element = element.nextElementSibling;
  }
  return null;
}

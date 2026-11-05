import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import Node from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts';
import ShadowRoot from '../../vendor/happy-dom/packages/happy-dom/src/nodes/shadow-root/ShadowRoot.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// DOM's adoption algorithm updates the node document of shadow-including
// descendants and their attributes, without replacing any node or prototype.
// Template contents have their own appropriate template document; they are
// deliberately not ordinary descendants of their template element here.
function setDocument(root, document) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    node[S.ownerDocument] = document;
    if (node[S.nodeType] === 1) {
      for (const attribute of node[S.attributes]) attribute[S.ownerDocument] = document;
      if (node[S.shadowRoot]) pending.push(node[S.shadowRoot]);
    }
    for (const child of node[S.nodeArray]) pending.push(child);
  }
}

function validate(document, node, importing, errors) {
  if (!(document instanceof Document)) throw new errors.TypeError('Illegal invocation');
  if (!(node instanceof Node)) throw new errors.TypeError('Parameter is not of type Node');
  if (node[S.nodeType] === 9)
    throw new errors.DOMException('A Document cannot be transferred', 'NotSupportedError');
  if (node instanceof ShadowRoot)
    throw new errors.DOMException('A ShadowRoot cannot be transferred', importing ? 'NotSupportedError' : 'HierarchyRequestError');
}

const defaultErrors = {TypeError, DOMException};
export function adoptNode(document, node, errors = defaultErrors) {
  validate(document, node, false, errors);
  // Removal must still run the native observer, iterator and disconnect hooks
  // while the subtree belongs to its previous document.
  if (node[S.nodeType] === 2) {
    node[S.ownerElement]?.[S.attributes][S.removeNamedItem](node);
  } else node[S.parentNode]?.removeChild(node);
  setDocument(node, document);
  return node;
}

const cloneNode = Node.prototype.cloneNode;
export function importNode(document, node, deep = false, errors = defaultErrors) {
  validate(document, node, true, errors);
  // Keep specialized clone steps (input state, namespace prefixes, etc.).
  const clone = cloneNode.call(node, deep);
  setDocument(clone, document);
  return clone;
}

Document.prototype.adoptNode = function(node) { return adoptNode(this, node); };
Document.prototype.importNode = function(node, deep = false) { return importNode(this, node, Boolean(deep)); };

// Insertion already walks each descendant and changes its internal document.
// Update only this element's attributes, before native connection callbacks
// can observe them, rather than rescanning every subtree at every level.
const connectedToNode = Node.prototype[S.connectedToNode];
Node.prototype[S.connectedToNode] = function() {
  if (this[S.nodeType] === 1) {
    const parent = this[S.parentNode] || this[S.host];
    const document = parent[S.ownerDocument] || parent;
    if (this[S.ownerDocument] !== document)
      for (const attribute of this[S.attributes]) attribute[S.ownerDocument] = document;
  }
  return connectedToNode.call(this);
};

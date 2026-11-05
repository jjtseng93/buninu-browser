import ParentNodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/parent-node/ParentNodeUtility.ts';
import HTMLCollection from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/HTMLCollection.ts';
import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// XML names are case-sensitive qualified names. HTML documents lowercase the
// query only for HTML-namespace elements; foreign element names stay exact.
ParentNodeUtility.getElementsByTagName = function(parent, name) {
  return new HTMLCollection(PropertySymbol.illegalConstructor, () => {
    const document = parent.nodeType === 9 ? parent : parent.ownerDocument;
    const html = document?.contentType === 'text/html';
    const key = JSON.stringify([html, name]);
    const cache = parent[PropertySymbol.cache].elementsByTagName;
    const previous = cache.get(key)?.result?.deref();
    if (previous) return previous;
    const folded = name.replace(/[A-Z]/g, c => c.toLowerCase());
    const entry = {result:null}, result = [], stack = [...parent[PropertySymbol.elementArray]].reverse();
    while (stack.length) {
      const node = stack.pop();
      node[PropertySymbol.affectsCache].push(entry);
      const qualified = node.prefix === null ? node.localName : `${node.prefix}:${node.localName}`;
      if (name === '*' || qualified === (html && node.namespaceURI === 'http://www.w3.org/1999/xhtml' ? folded : name)) result.push(node);
      const children = node[PropertySymbol.elementArray];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    entry.result = new WeakRef(result);cache.set(key, entry);return result;
  });
};

// Namespace queries match localName case-sensitively, including on a Document
// (whose ownerDocument is null). The old utility assumed an element owner and
// compared uppercased tagName, and did not implement the wildcard namespace.
ParentNodeUtility.getElementsByTagNameNS = function(parent, namespace, localName) {
  namespace = namespace === '' ? null : namespace;
  const key = JSON.stringify([namespace, localName]);
  return new HTMLCollection(PropertySymbol.illegalConstructor, () => {
    const cache = parent[PropertySymbol.cache].elementsByTagNameNS;
    const previous = cache.get(key)?.result?.deref();
    if (previous) return previous;
    const entry = {result:null};
    const result = [], stack = [...parent[PropertySymbol.elementArray]].reverse();
    while (stack.length) {
      const node = stack.pop();
      node[PropertySymbol.affectsCache].push(entry);
      if ((namespace === '*' || node.namespaceURI === namespace) && (localName === '*' || node.localName === localName)) result.push(node);
      const children = node[PropertySymbol.elementArray];
      for (let i=children.length-1;i>=0;i--) stack.push(children[i]);
    }
    entry.result = new WeakRef(result);
    cache.set(key, entry);
    return result;
  });
};
const images = new WeakMap();
Object.defineProperty(Document.prototype, 'images', {
  get() {
    let collection = images.get(this);
    if (!collection) {
      collection = this.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'img');
      images.set(this, collection);
    }
    return collection;
  }, configurable:true, enumerable:true,
});

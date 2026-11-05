import ParentNodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/parent-node/ParentNodeUtility.ts';
import HTMLCollection from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/HTMLCollection.ts';
import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

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

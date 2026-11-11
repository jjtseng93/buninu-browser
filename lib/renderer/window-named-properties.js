// HTML named access on Window. Keep names on the per-document prototype,
// below explicit window properties, and resolve the live document at access
// time so renaming/removing an element never leaves a stale global behind.
import {proxy} from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

export function windowNamedProperties(document, realm, prototype) {
  const namedTags = new Set(['EMBED', 'FORM', 'IMG', 'OBJECT']);
  const collections = new Map();
  let index = null;
  const elementNames = new WeakMap();
  function updateElement(element) {
    // Form/select mutation records can carry the raw node while DOM queries
    // return its named-property proxy. Keep one identity in both indexes.
    element = element[proxy] ?? element;
    for (const name of elementNames.get(element) || []) {
      const items = index.get(name);
      items?.delete(element);
      if (!items?.size) index.delete(name);
    }
    elementNames.delete(element);
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.getRootNode() !== document) return;
    const names = new Set();
    const id = element.getAttribute('id');
    if (id) names.add(id);
    if (namedTags.has(element.tagName) || element.tagName === 'IFRAME') {
      const name = element.getAttribute('name');
      if (name) names.add(name);
    }
    if (!names.size) return;
    elementNames.set(element, names);
    for (const name of names) {
      let items = index.get(name);
      if (!items) index.set(name, items = new Set());
      items.add(element);
    }
  }
  function update(records) {
    if (!index || !records.length) return;
    const changed = new Set();
    const collect = root => {
      if (root.nodeType !== 1) return;
      const stack = [root];
      while (stack.length) {
        const element = stack.pop();
        if (changed.has(element)) continue;
        changed.add(element);
        // Ordinary descendants only: shadow and template contents are not
        // Window names. Iterative traversal also handles deeply nested trees.
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) stack.push(child);
      }
    };
    for (const record of records) {
      if (record.type === 'attributes') continue;
      for (const node of record.addedNodes) collect(node);
      for (const node of record.removedNodes) collect(node);
    }
    for (const record of records) if (record.type === 'attributes') changed.add(record.target);
    for (const element of changed) updateElement(element);
  }
  const observer = new document.defaultView.MutationObserver(update);
  observer.observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['id', 'name']});
  function matches(name) {
    if (!name || typeof name !== 'string') return [];
    // Named access is synchronous, including mutations within the same script.
    // Drain before lookup instead of waiting for observer microtask delivery.
    // Only changed subtrees/attributes update the index. Missing globals are
    // O(1), and arbitrary property names never become CSS selector source.
    update(observer.takeRecords());
    if (!index) {
      index = new Map();
      for (const element of document.querySelectorAll('[id], [name]')) updateElement(element);
    }
    const items = [...(index.get(name) || [])];
    // Insertion order differs from document order after moving a subtree.
    if (items.length > 1) items.sort((a,b) => a.compareDocumentPosition(b) & 2 ? 1 : -1);
    return items;
  }
  function value(name, items) {
    const frame = items.find(e => e.tagName === 'IFRAME' && e.getAttribute('name') === name);
    if (frame) return realm.wrap(frame).contentWindow;
    if (items.length === 1) return realm.wrap(items[0]);
    let collection = collections.get(name);
    if (!collection) {
      collection = realm.live(new Proxy({}, {
        get(_target, key) {
          const current = matches(name);
          if (key === 'length') return current.length;
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return current[Number(key)];
        },
      }));
      collections.set(name, collection);
    }
    return collection;
  }
  return new Proxy(Object.create(prototype), {
    get(target, name, receiver) {
      if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
      const items = matches(name);
      return items.length ? value(name, items) : undefined;
    },
    has: (target, name) => Reflect.has(target, name) || matches(name).length > 0,
    getOwnPropertyDescriptor(target, name) {
      const own = Reflect.getOwnPropertyDescriptor(target, name);
      if (own || Reflect.has(target, name)) return own;
      const items = matches(name);
      return items.length ? {value:value(name, items), writable:true, enumerable:true, configurable:true} : undefined;
    },
  });
}

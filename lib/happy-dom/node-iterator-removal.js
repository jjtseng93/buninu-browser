import Node from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts';
import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// NodeIterator's pre-removing steps must run synchronously, including removals
// by innerHTML, normalize and reparenting. All reach Happy DOM's internal hook.
const roots = new WeakMap();
const cleanup = new FinalizationRegistry(({ entries, ref }) => entries.delete(ref));
let installed = false;
export function observeIteratorRemoval(root, iterator) {
  let entries = roots.get(root);
  if (!entries) roots.set(root, entries = new Set());
  const ref = new WeakRef(iterator);
  entries.add(ref);
  cleanup.register(iterator, { entries, ref });
  if (installed) return;
  installed = true;
  const remove = Node.prototype[PropertySymbol.removeChild];
  Node.prototype[PropertySymbol.removeChild] = function(node) {
    node = node?.[PropertySymbol.proxy] ?? node;
    // select/form methods are bound to the raw target, while parentNode and
    // iterator roots expose its proxy. Compare and walk the public identity.
    const parent = this[PropertySymbol.proxy] ?? this;
    if (node?.parentNode === parent) {
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentNode) {
        const entries = roots.get(ancestor);
        if (!entries) continue;
        for (const ref of entries) {
          const iterator = ref.deref();
          if (iterator) iterator.preRemove(node);
          else entries.delete(ref);
        }
      }
    }
    return remove.call(this, node);
  };
}

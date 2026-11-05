import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {assignedSlot, slotAssignedNodes} from '../renderer/slot-assignment.js';

// Engine-only access: a closed root participates in rendering without being
// exposed by Element.shadowRoot to page scripts.
export function shadowRootFor(element) {
  return element?.[PropertySymbol.shadowRoot] ?? null;
}

export function shadowRootsIn(root, visited = null) {
  const roots = [];
  const pending = [...root.children ?? []];
  while (pending.length) {
    const element = pending.pop();
    if (visited?.has(element)) continue;
    visited?.add(element);
    const shadow = shadowRootFor(element);
    if (shadow) { roots.push(shadow); pending.push(...shadow.children); }
    pending.push(...element.children);
  }
  return roots;
}

// Slots retain their own style/inheritance node (normally display:contents).
// Flattening their assigned children here never moves or clones author DOM.
export function renderedChildren(element) {
  const shadow = shadowRootFor(element);
  if (shadow) return shadow.childNodes;
  if (element.localName === 'slot' && element.getRootNode().host) {
    const assigned = slotAssignedNodes(element);
    if (assigned.length) return assigned;
  }
  return element.childNodes;
}

/** Parent used by rendering/scroll geometry, not by DOM selector matching. */
export function composedParentElement(node) {
  return assignedSlot(node) ?? node?.parentElement ?? node?.parentNode?.host ?? null;
}

export function composedContains(ancestor, node) {
  if (!ancestor || !node) return false;
  if (ancestor.contains(node)) return true;
  for (let current = node; current; current = composedParentElement(current)) if (current === ancestor) return true;
  return false;
}

// DOM retargeting at a public boundary. Input dispatch still uses the actual
// painted descendant; a listener within that root may see it, an outside
// listener/document hit-test sees the corresponding host instead.
export function retargetShadowNode(node, against) {
  const scope = against?.getRootNode?.();
  for (let root = node?.getRootNode?.(); root?.host; root = node.getRootNode()) {
    for (let current = scope; current; current = current.host?.getRootNode()) if (current === root) return node;
    node = root.host;
  }
  return node;
}

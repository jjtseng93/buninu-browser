import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// DOM slot assignment, shared by the page bindings and flattened-tree users.
// Keep only manual assignments: named slots follow the current tree directly.
const manualNodes = new WeakMap();
const manualOwner = new WeakMap();
const isSlottable = node => node?.nodeType === 1 || node?.nodeType === 3;

export function assignedSlot(node, openOnly = false) {
  const root = node?.parentElement?.[PropertySymbol.shadowRoot];
  if (!root || !isSlottable(node) || openOnly && root.mode === 'closed') return null;
  if (root.slotAssignment === "manual") {
    const slot = manualOwner.get(node);
    return slot?.getRootNode() === root ? slot : null;
  }
  const name = node.nodeType === 1 ? node.getAttributeNS(null, "slot") ?? "" : "";
  return [...root.querySelectorAll("slot")].find(slot => (slot.getAttributeNS(null, "name") ?? "") === name) ?? null;
}

export function slotAssignedNodes(slot, flatten = false, visiting = new Set()) {
  const root = slot.getRootNode();
  if (!root.host || visiting.has(slot)) return [];
  let nodes;
  if (root.slotAssignment === "manual") {
    nodes = (manualNodes.get(slot) ?? []).filter(node => node.parentNode === root.host);
  } else {
    const name = slot.getAttributeNS(null, "name") ?? "";
    const first = [...root.querySelectorAll("slot")].find(candidate => (candidate.getAttributeNS(null, "name") ?? "") === name);
    nodes = first !== slot ? [] : [...root.host.childNodes].filter(node => isSlottable(node)
      && (node.nodeType === 1 ? node.getAttributeNS(null, "slot") ?? "" : "") === name);
  }
  if (!flatten) return nodes;
  visiting.add(slot);
  const flattened = [];
  if (!nodes.length) nodes = [...slot.childNodes].filter(isSlottable);
  for (const node of nodes) {
    if (node.localName === "slot" && node.getRootNode().host) flattened.push(...slotAssignedNodes(node, true, visiting));
    else flattened.push(node);
  }
  visiting.delete(slot);
  return flattened;
}

export function assignSlotNodes(slot, nodes, notify) {
  if (nodes.some(node => !isSlottable(node))) throw new TypeError("Assigned nodes must be elements or text nodes");
  if (slot.getRootNode().slotAssignment !== "manual") return;
  const unique = [...new Set(nodes)];
  const previous = manualNodes.get(slot) ?? [];
  const changed = unique.length !== previous.length || unique.some((node, index) => node !== previous[index]);
  if (!changed) return;
  for (const node of previous) if (manualOwner.get(node) === slot) manualOwner.delete(node);
  for (const node of unique) {
    const old = manualOwner.get(node);
    if (old && old !== slot) {
      manualNodes.set(old, (manualNodes.get(old) ?? []).filter(item => item !== node));
      notify(old);
    }
    manualOwner.set(node, slot);
  }
  manualNodes.set(slot, unique);
  notify(slot);
}

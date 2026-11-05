// Renderer-owned state only: page bindings never receive these records.
const associated = new WeakMap();
export function associatedSheet(node) { return associated.get(node); }
export function associateSheet(node, state) { associated.set(node, state); }
export function sheetText(node, source) {
  const state = associated.get(node);
  return state && state.source === source && state.changed ? state.text : source;
}
export function sheetDisabled(node) { const s=associated.get(node);return s ? (s.owner ? Boolean(s.owner.disabled) : s.disabled) : false; }

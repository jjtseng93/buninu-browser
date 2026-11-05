import './range-boundaries.js';
import {preRemoveRangeBoundaries, insertRangeBoundaries} from './node-normalize.js';
import {preRemoveIterators} from './node-iterator-removal.js';
import {withCustomElementReactions, enqueueCustomElementCallback} from './node-replace-all.js';
import {slotAssignedNodes} from '../renderer/slot-assignment.js';
import {signalSlotChange} from './slot-notifications.js';
import {excludePeers, formOwner} from './radio-groups.js';
import MutationRecord from '../../vendor/happy-dom/packages/happy-dom/src/mutation-observer/MutationRecord.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const moveCallbacks = new WeakMap();
// The definition captures callbacks once, just like the other CE lifecycle
// callbacks. Storing the adapter weakly must not retain a disposed page realm.
export function registerConnectedMoveCallback(Adapter, callback) {
  moveCallbacks.set(Adapter, callback);
}
const parentOrHost = node => node[S.parentNode] ?? node[S.host];
function shadowIncludingRoot(node) {
  let parent;
  while ((parent = parentOrHost(node))) node = parent;
  return node;
}
function descendants(node) {
  const result = [], pending = [node];
  while (pending.length) {
    const item = pending.pop(); result.push(item);
    for (let i = item[S.nodeArray].length - 1; i >= 0; i--) pending.push(item[S.nodeArray][i]);
    if (item[S.shadowRoot]) pending.push(item[S.shadowRoot]);
  }
  return result;
}
function slotsIn(root, slots = new Set()) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node.localName === 'slot') slots.add(node);
    for (const child of node[S.elementArray]) pending.push(child);
  }
  return slots;
}
function rebuildAncestors(nodes) {
  // Do not call connectedToNode/disconnectedFromNode: those run insertion or
  // removal steps that reset focus, media/iframe state and text selection.
  for (const node of nodes) {
    const parent = node[S.parentNode];
    if (!parent) continue; // A shadow root keeps its own ordinary root.
    node[S.rootNode] = parent[S.rootNode];
    for (const [symbol, tag] of [[S.styleNode,'STYLE'], [S.textAreaNode,'TEXTAREA'], [S.formNode,'FORM'], [S.selectNode,'SELECT']]) {
      if (node[S.tagName] !== tag) node[symbol] = parent[symbol] ?? null;
    }
    node[S.clearCache]();
  }
}

/** DOM atomic move, https://dom.spec.whatwg.org/#concept-node-move.
 * Identity and connectedness never change. Only the structural removal/move
 * steps run; insertion/removal steps (script execution, reload, focus loss,
 * animation/media teardown) deliberately do not. */
export function moveNodeBefore(parent, node, child, Exception = DOMException) {
  parent = parent[S.proxy] ?? parent;
  node = node[S.proxy] ?? node;
  child = child?.[S.proxy] ?? child;
  if (child === node) child = node.nextSibling;
  const fail = (name, message) => { throw new Exception(message, name); };
  if (shadowIncludingRoot(parent) !== shadowIncludingRoot(node))
    fail('HierarchyRequestError', 'An atomic move requires the same shadow-including root');
  for (let ancestor = parent; ancestor; ancestor = parentOrHost(ancestor))
    if (ancestor === node) fail('HierarchyRequestError', 'Cannot move an ancestor into its descendant');
  if (child && child[S.parentNode] !== parent) fail('NotFoundError', 'The reference child is not a child of this parent');
  if (![1,3,4,7,8].includes(node[S.nodeType])) fail('HierarchyRequestError', 'Only Element or CharacterData can be moved');
  if (parent[S.nodeType] === 9) {
    if (node[S.nodeType] === 3 || node[S.nodeType] === 4)
      fail('HierarchyRequestError', 'A document cannot contain Text');
    if (node[S.nodeType] === 1 && (parent[S.elementArray].length
      || child && parent[S.nodeArray].slice(parent[S.nodeArray].indexOf(child)).some(item => item[S.nodeType] === 10)))
      fail('HierarchyRequestError', 'The move would violate document child ordering');
  }
  const oldParent = node[S.parentNode], nodes = descendants(node);
  const oldPrevious = node.previousSibling, oldNext = node.nextSibling;
  const oldIndex = oldParent[S.nodeArray].indexOf(node);
  // Only a direct host's light children or slots in the affected ordinary
  // shadow roots can change assignment. Never scan an entire document (or
  // unrelated/nested shadow trees) for an ordinary reorder without slots.
  const oldRoot = oldParent.getRootNode(), newRoot = parent.getRootNode();
  const slots = new Set();
  const roots = new Set([oldParent[S.shadowRoot], parent[S.shadowRoot],
    oldRoot[S.host] ? oldRoot : null, newRoot[S.host] ? newRoot : null]);
  for (const root of roots) if (root) slotsIn(root, slots);
  if (newRoot[S.host]) slotsIn(node, slots);
  const assignments = new Map([...slots].map(slot => [slot, slotAssignedNodes(slot)]));
  const selects = new Set(nodes.map(item => item[S.selectNode]).filter(Boolean));
  const selected = nodes.filter(item => item.localName === 'option' && item[S.selectedness]);
  const points = preRemoveRangeBoundaries(node);
  preRemoveIterators(node);
  for (const item of nodes) if (item[S.isConnected] && item[S.nodeType] === 1)
    item[S.removeIdentifierFromWindow](item.getAttribute('id'));
  for (const listener of [...oldParent[S.mutationListeners]])
    if (listener.options.subtree) node[S.unobserveMutations](listener);
  oldParent[S.nodeArray].splice(oldIndex, 1);
  if (node[S.nodeType] === 1) oldParent[S.elementArray].splice(oldParent[S.elementArray].indexOf(node), 1);
  const index = child ? parent[S.nodeArray].indexOf(child) : parent[S.nodeArray].length;
  if (child) insertRangeBoundaries(points, parent, index);
  const previous = parent[S.nodeArray][index - 1] ?? null;
  parent[S.nodeArray].splice(index, 0, node);
  if (node[S.nodeType] === 1) {
    const elementIndex = parent[S.nodeArray].slice(0, index).filter(item => item[S.nodeType] === 1).length;
    parent[S.elementArray].splice(elementIndex, 0, node);
  }
  node[S.parentNode] = parent;
  node[S.assignedToSlot] = null;
  oldParent[S.clearCache](); parent[S.clearCache]();
  rebuildAncestors(nodes);
  for (const item of nodes) {
    if (item[S.isConnected] && item[S.nodeType] === 1) item[S.addIdentifierToWindow](item.getAttribute('id'));
    if (item[S.selectNode]) selects.add(item[S.selectNode]);
  }
  // Moving a checked radio into another tree/form changes its group without
  // changing dirty checkedness. Reuse group exclusion, not the checked setter.
  for (const item of nodes)
    if (item.localName === 'input' && item.type === 'radio' && item.checked && (item.isConnected || formOwner(item))) excludePeers(item);
  for (const listener of [...parent[S.mutationListeners]])
    if (listener.options.subtree) node[S.observeMutations](listener);
  for (const select of selects)
    select[S.updateSelectedness](selected.findLast(option => option[S.selectNode] === select));
  // Moving children changes style/textarea text contents, including text in
  // a moved subtree. Moving a whole textarea leaves its own selection intact.
  for (const textarea of new Set([oldParent[S.textAreaNode], parent[S.textAreaNode]])) textarea?.[S.resetSelection]();
  for (const style of new Set([oldParent[S.styleNode], parent[S.styleNode]])) style?.[S.updateSheet]();
  for (const slot of slots) {
    const before = assignments.get(slot), after = slotAssignedNodes(slot);
    if (before.length !== after.length || before.some((item,i) => item !== after[i])
      || (slot === oldParent || slot === parent) && slot.getRootNode().host && !after.length)
      signalSlotChange(slot);
  }
  oldParent[S.reportMutation](new MutationRecord({type:'childList',target:oldParent,removedNodes:[node],previousSibling:oldPrevious,nextSibling:oldNext}));
  parent[S.reportMutation](new MutationRecord({type:'childList',target:parent,addedNodes:[node],previousSibling:previous,nextSibling:child}));
  withCustomElementReactions(() => {
    for (const element of nodes) {
      if (!element[S.isConnected] || element[S.nodeType] !== 1) continue;
      const window = element[S.window];
      const definition = window.customElements[S.registry]?.get(element.localName);
      if (!definition || !(element instanceof definition.elementClass)) continue;
      const captured = moveCallbacks.get(definition.elementClass);
      if (captured) enqueueCustomElementCallback(element, window, captured);
      else {
        // Also support native DOM tests/clients without page-facing adapters.
        const callbacks = definition.lifecycleCallbacks;
        for (const name of ['disconnectedCallback','connectedCallback'])
          if (callbacks[name]) enqueueCustomElementCallback(element, window, callbacks[name]);
      }
    }
  });
  return oldParent;
}

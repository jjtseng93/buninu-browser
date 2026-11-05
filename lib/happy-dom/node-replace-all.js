import MutationRecord from '../../vendor/happy-dom/packages/happy-dom/src/mutation-observer/MutationRecord.ts';
import CustomElementReactionStack from '../../vendor/happy-dom/packages/happy-dom/src/custom-element/CustomElementReactionStack.ts';
import WindowBrowserContext from '../../vendor/happy-dom/packages/happy-dom/src/window/WindowBrowserContext.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {withoutNativeSlotChanges} from './slot-notifications.js';

const replacing = new Set();
const completedRecords = new WeakSet();
const reactions = new WeakMap();
let scope = null;

// Suppression applies to one DOM algorithm, before notification or takeRecords.
// Native listeners still receive removals so transient subtree observers and
// the engine's own mutation hooks remain active.
export const suppressReplaceAllRecord = record =>
  record.type === 'childList' && replacing.has(record.target) && !completedRecords.has(record);

const enqueueReaction = CustomElementReactionStack.prototype.enqueueReaction;
function captureReaction(stack, [element, name, args = []]) {
  const definition = stack.window.customElements[S.registry]?.get(element.localName);
  if (!definition || !(element instanceof definition.elementClass)
    || element[S.ownerDocument] !== stack.window.document) return null;
  const callback = definition.lifecycleCallbacks[name];
  if (!callback || (name === 'attributeChangedCallback' && !definition.observedAttributes.has(args[0]))) return null;
  return {stack, element, name, callback, args:[...args]};
}
function invokeReactions(element) {
  const queue = reactions.get(element);
  if (!queue) return;
  while (queue.length) {
    const {stack, name, callback, args} = queue.shift();
    withoutNativeSlotChanges(() => {
      try {
        // Callback eligibility and defining context belong to enqueue time:
        // an earlier reaction can adopt this element before its turn arrives.
        const result = callback.apply(element, args);
        if (name === 'connectedCallback' && result instanceof Promise) {
          const manager = new WindowBrowserContext(stack.window).getAsyncTaskManager();
          if (manager) {
            const task = manager.startTask();
            result.then(() => manager.endTask(task), () => manager.endTask(task));
          }
        }
      } catch (error) { stack.window[S.dispatchError](error); }
    });
  }
  if (reactions.get(element) === queue) reactions.delete(element);
}
CustomElementReactionStack.prototype.enqueueReaction = function(...args) {
  const element = args[0];
  if (!scope && !reactions.has(element))
    return withoutNativeSlotChanges(() => enqueueReaction.apply(this, args));
  const reaction = captureReaction(this, args);
  if (!reaction) return;
  let queue = reactions.get(element);
  if (!queue) reactions.set(element, queue = []);
  queue.push(reaction);
  if (scope) scope.elements.add(element);
  else invokeReactions(element);
};

// Shared by atomic moves so nested ordinary DOM reactions use the same
// per-element queues and cannot overtake earlier captured reactions.
export function withCustomElementReactions(callback) {
  const previous = scope, current = {elements:new Set()};
  scope = current;
  try { return callback(); }
  finally {
    scope = previous;
    for (const element of current.elements) invokeReactions(element);
  }
}
export function enqueueCustomElementCallback(element, window, callback) {
  let queue = reactions.get(element);
  if (!queue) reactions.set(element, queue = []);
  queue.push({stack:{window},element,name:'connectedMoveCallback',callback,args:[]});
  if (scope) scope.elements.add(element);
  else invokeReactions(element);
}

/** DOM string replace all. Preserve native removals/insertions and their
 * cache, selection, style, slot and iterator hooks; only suppress intermediate
 * observer records and defer custom reactions until the replacement is whole.
 * https://dom.spec.whatwg.org/#concept-node-replace-all */
export function stringReplaceAll(parent, value) {
  parent = parent[S.proxy] ?? parent;
  const added = value ? parent.ownerDocument.createTextNode(value) : null;
  const removed = [...parent[S.nodeArray]];
  if (!added && !removed.length) return;
  const previousScope = scope;
  const current = {elements:new Set()};
  const alreadyReplacing = replacing.has(parent);
  scope = current;
  replacing.add(parent);
  let completed = false;
  try {
    for (const child of removed) parent[S.removeChild](child);
    if (added) parent[S.appendChild](added);
    completed = true;
  } finally {
    if (!alreadyReplacing) replacing.delete(parent);
    scope = previousScope;
    // Even a failing internal hook must leave no active suppression or queued
    // reactions behind. Report only mutations that actually completed.
    const removedNodes = completed ? removed : removed.filter(node => node.parentNode !== parent);
    const addedNodes = added?.parentNode === parent ? [added] : [];
    try {
      if (removedNodes.length || addedNodes.length) {
        const record = new MutationRecord({type:'childList',target:parent,removedNodes,addedNodes});
        completedRecords.add(record);
        parent[S.reportMutation](record);
      }
    } finally {
      for (const element of current.elements) invokeReactions(element);
    }
  }
}

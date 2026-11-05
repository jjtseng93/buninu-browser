import './form-validation-candidate.js';
import { formOwner } from './radio-groups.js';
import SelectorItem from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts";
import QuerySelector from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/QuerySelector.ts";
import Node from "../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts";
import HTMLInputElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts";
import HTMLTextAreaElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts";
import HTMLSelectElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts";
import HTMLButtonElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-button-element/HTMLButtonElement.ts";
import HTMLOptionElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-option-element/HTMLOptionElement.ts";
import HTMLFormElement from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-form-element/HTMLFormElement.ts";
import * as PropertySymbol from "../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts";
import { compileSelector, matchesCompiled } from "./selector-matcher.js";

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const controls = new Set(['input', 'select', 'textarea', 'button']);
const isCandidate = element => element.namespaceURI === htmlNamespace &&
  controls.has(element.localName) && element.willValidate;

function* descendants(root) {
  const pending = [...root.children].reverse();
  while (pending.length) {
    const element = pending.pop();
    yield element;
    for (let i = element.children.length - 1; i >= 0; i--) pending.push(element.children[i]);
  }
}

// Matching must not call checkValidity(): that API dispatches invalid events.
function validityMatch(element) {
  if (element.namespaceURI !== htmlNamespace) return null;
  if (element.localName === 'form' || element.localName === 'fieldset') {
    const form = element.localName === 'form';
    const root = form ? element.getRootNode() : element;
    for (const control of descendants(root)) {
      const owner = form ? formOwner(control) : null;
      const belongs = !form || (owner?.[PropertySymbol.proxy] ?? owner) === (element[PropertySymbol.proxy] ?? element);
      if (isCandidate(control) && belongs && !control.validity.valid) return false;
    }
    return true;
  }
  return isCandidate(element) ? element.validity.valid : null;
}

// DOM state setters do not all invalidate Happy DOM's selector caches. A
// generation check invalidates those caches once after a mutation, instead
// of recreating cache records (and their affectsCache links) on every query.
// Escaped selector spellings are conservative candidates for this check.
const validitySelector = /:(?:valid|invalid)(?![\w-])|\\/i;
let validityGeneration = 0;
let clearingForQuery = false;
const generationSeen = new WeakMap();
const rootGenerationSeen = new WeakMap();
const clearCache = Node.prototype[PropertySymbol.clearCache];
Node.prototype[PropertySymbol.clearCache] = function(...args) {
  if (!clearingForQuery) validityGeneration++;
  return clearCache.apply(this, args);
};
for (const name of ['matches', 'querySelector', 'querySelectorAll']) {
  const query = QuerySelector[name];
  QuerySelector[name] = function(node, selector, ...args) {
    if (typeof selector === 'string' && validitySelector.test(selector) && generationSeen.get(node) !== validityGeneration) {
      clearingForQuery = true;
      try {
        const root = node.getRootNode();
        if (rootGenerationSeen.get(root) !== validityGeneration) {
          root[PropertySymbol.clearCache]();
          rootGenerationSeen.set(root, validityGeneration);
        }
        if (node !== root) node[PropertySymbol.clearCache]();
      }
      finally { clearingForQuery = false; }
      generationSeen.set(node, validityGeneration);
    }
    return query.call(this, node, selector, ...args);
  };
}
QuerySelector.globalMatchFunction = QuerySelector.matches.bind(QuerySelector);
for (const Type of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement, HTMLOptionElement, HTMLFormElement]) {
  for (const name of ['value', 'checked', 'selected', 'selectedIndex', 'files']) {
    const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(Type.prototype, name, { ...descriptor, set(value) {
      try { return descriptor.set.call(this, value); }
      finally { validityGeneration++; }
    } });
  }
  for (const name of ['setCustomValidity', 'reset', 'setRangeText']) {
    const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, name);
    if (typeof descriptor?.value !== 'function') continue;
    Object.defineProperty(Type.prototype, name, { ...descriptor, value(...args) {
      try { return descriptor.value.apply(this, args); }
      finally { validityGeneration++; }
    } });
  }
}

// Happy DOM's :empty checks only element children. CSS also excludes elements
// with nonempty text nodes (including whitespace); comments do not count.
const original = SelectorItem.prototype.matchPseudoItem;
const selectorLists = new WeakMap();
SelectorItem.prototype.matchPseudoItem = function (scope, element, siblings, pseudo, ignoreErrors) {
  if (pseudo.name === 'valid' || pseudo.name === 'invalid') {
    const valid = validityMatch(element);
    return valid !== null && valid === (pseudo.name === 'valid') ? { priorityWeight: 10 } : null;
  }
  if (pseudo.name === "focus-within") {
    const focused = element.ownerDocument?.activeElement;
    return focused && (focused === element || element.contains(focused)) ? {priorityWeight:10} : null;
  }
  // Functional selector lists match their complete complex selectors. The
  // upstream per-item path tests only a group's first compound, so e.g.
  // :where(h2 code) incorrectly matches the h2 instead of its code child.
  if (["is", "where", "not"].includes(pseudo.name) && pseudo.arguments) {
    let compiled = selectorLists.get(pseudo);
    if (compiled === undefined) {
      compiled = compileSelector(element, pseudo.arguments) ?? null;
      selectorLists.set(pseudo, compiled);
    }
    const matches = compiled && matchesCompiled(element, compiled, scope);
    return (pseudo.name === "not" ? !matches : matches)
      ? { priorityWeight: pseudo.name === "where" ? 0 : 10 } : null;
  }
  if (pseudo.name === "empty") {
    for (const child of element.childNodes) {
      if (child.nodeType === 1 || (child.nodeType === 3 || child.nodeType === 4) && child.data.length) return null;
    }
    return { priorityWeight: 10 };
  }
  return original.call(this, scope, element, siblings, pseudo, ignoreErrors);
};

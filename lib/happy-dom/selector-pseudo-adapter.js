import SelectorItem from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts";
import { compileSelector, matchesCompiled } from "./selector-matcher.js";

// Happy DOM's :empty checks only element children. CSS also excludes elements
// with nonempty text nodes (including whitespace); comments do not count.
const original = SelectorItem.prototype.matchPseudoItem;
const selectorLists = new WeakMap();
SelectorItem.prototype.matchPseudoItem = function (scope, element, siblings, pseudo, ignoreErrors) {
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

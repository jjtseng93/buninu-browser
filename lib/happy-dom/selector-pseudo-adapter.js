import SelectorItem from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts";

// Happy DOM's :empty checks only element children. CSS also excludes elements
// with nonempty text nodes (including whitespace); comments do not count.
const original = SelectorItem.prototype.matchPseudoItem;
SelectorItem.prototype.matchPseudoItem = function (scope, element, siblings, pseudo, ignoreErrors) {
  if (pseudo.name === "empty") {
    for (const child of element.childNodes) {
      if (child.nodeType === 1 || (child.nodeType === 3 || child.nodeType === 4) && child.data.length) return null;
    }
    return { priorityWeight: 10 };
  }
  return original.call(this, scope, element, siblings, pseudo, ignoreErrors);
};

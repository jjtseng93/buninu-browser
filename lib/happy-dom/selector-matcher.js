import * as PropertySymbol from "../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts";
import QuerySelector from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/QuerySelector.ts";
import SelectorCombinatorEnum from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorCombinatorEnum.ts";
import SelectorParser from "../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorParser.ts";

/**
 * Selector matching for the style engine, which matches tens of thousands of
 * stylesheet selectors against every element. It gives the answers of Happy
 * DOM's Element.matches() (same parser, same per-compound matching), without
 * what that pays on every call: re-validating and looking up the selector
 * string, and recording a cached result on the element and the elements it
 * visited. The style engine keeps its own results.
 */

// Element.matches() rejects these before parsing (Happy DOM's QuerySelector).
const INVALID_SELECTOR = /^[.#\[]?\d|[.#]$/;

/**
 * A selector compiled for matchesCompiled(), or null when it is invalid.
 * `element` is any element of the document (it provides the window). The
 * result does not depend on the document and may be kept with the selector.
 * Returns undefined for objects that are not Happy DOM elements.
 */
export function compileSelector(element, selector) {
  const window = element?.[PropertySymbol.window];
  if (!window) return undefined;
  selector = String(selector);
  if (INVALID_SELECTOR.test(selector)) return null;
  try {
    const groups = new SelectorParser({ window, scope: element, globalMatchFunction: QuerySelector.globalMatchFunction })
      .getSelectorGroups(selector);
    // Matching walks from the subject (the last compound) leftwards.
    return groups.map((items) => items.slice().reverse());
  } catch {
    return null;
  }
}

/** Whether `element` matches a compiled selector, as element.matches(selector) would. */
export function matchesCompiled(element, compiled) {
  for (const items of compiled) {
    if (matchItems(element, element, items, 0, null)) return true;
  }
  return false;
}

/** Happy DOM's QuerySelector.matchSelector, reduced to a yes or no. */
function matchItems(scope, element, items, index, previous) {
  const item = items[index];
  if (!item) return false;
  if (item.match(scope, element)) {
    if (index === items.length - 1) return true;
    switch (item.combinator) {
      case SelectorCombinatorEnum.adjacentSibling: {
        const sibling = element.previousElementSibling;
        if (sibling && matchItems(scope, sibling, items, index + 1, item)) return true;
        break;
      }
      case SelectorCombinatorEnum.none:
      case SelectorCombinatorEnum.child:
      case SelectorCombinatorEnum.descendant: {
        const parent = element.parentNode;
        if (parent && parent !== element[PropertySymbol.ownerDocument] && matchItems(scope, parent, items, index + 1, item)) return true;
        break;
      }
      case SelectorCombinatorEnum.subsequentSibling: {
        const parent = element.parentNode;
        if (parent && parent !== element[PropertySymbol.ownerDocument]) {
          const siblings = parent[PropertySymbol.elementArray];
          for (let i = siblings.indexOf(element) - 1; i >= 0; i--) {
            if (matchItems(scope, siblings[i], items, index + 1, item)) return true;
          }
        }
        break;
      }
    }
  }
  if (previous?.combinator === SelectorCombinatorEnum.none || previous?.combinator === SelectorCombinatorEnum.descendant) {
    const parent = element.parentNode;
    if (parent && parent !== element[PropertySymbol.ownerDocument]) return matchItems(scope, parent, items, index, previous);
  }
  return false;
}

import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// The renderer owns linked-resource loading and its load/error events. Happy
// DOM's disabled CSS loader still emits an immediate error when a link connects
// or changes href. Keep only the ordinary HTMLElement lifecycle in inert windows.
export function makeLinksInert(window) {
  const base = window.HTMLElement.prototype;
  const prototype = window.HTMLLinkElement.prototype;
  prototype[PropertySymbol.connectedToDocument] = function() {
    base[PropertySymbol.connectedToDocument].call(this);
    this.ownerDocument[PropertySymbol.clearComputedStyleCache]();
  };
  prototype[PropertySymbol.onSetAttribute] = function(attribute, replacedAttribute) {
    base[PropertySymbol.onSetAttribute].call(this, attribute, replacedAttribute);
  };
}

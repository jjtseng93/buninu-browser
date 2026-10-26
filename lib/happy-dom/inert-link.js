import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Happy DOM shares HTMLLinkElement.prototype between windows. Install one
// dispatch hook, but bypass its loader only for windows owned by our renderer.
const inertWindows = new WeakSet();
let installed = false;
export function makeLinksInert(window) {
  inertWindows.add(window);
  if (installed) return;
  installed = true;
  const base = window.HTMLElement.prototype;
  const prototype = window.HTMLLinkElement.prototype;
  const connected = prototype[PropertySymbol.connectedToDocument];
  const setAttribute = prototype[PropertySymbol.onSetAttribute];
  prototype[PropertySymbol.connectedToDocument] = function() {
    if (!inertWindows.has(this[PropertySymbol.window])) return connected.call(this);
    // The renderer owns load/error dispatch; the disabled parser loader must
    // not emit a premature error when a dynamic stylesheet is connected.
    base[PropertySymbol.connectedToDocument].call(this);
    this.ownerDocument[PropertySymbol.clearComputedStyleCache]();
  };
  prototype[PropertySymbol.onSetAttribute] = function(attribute, replacedAttribute) {
    if (!inertWindows.has(this[PropertySymbol.window])) return setAttribute.call(this, attribute, replacedAttribute);
    base[PropertySymbol.onSetAttribute].call(this, attribute, replacedAttribute);
  };
}

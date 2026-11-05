import HTMLIFrameElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-iframe-element/HTMLIFrameElement.ts';
import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// The renderer, rather than the inert parser's iframe loader, owns these
// browsing contexts. HTML removes a context during DOM removal, not at the
// next paint or MutationObserver checkpoint. This also catches a removed
// ancestor/shadow host and remove+reinsert within the same script task.
const disconnectors = new WeakMap();
const disconnected = HTMLIFrameElement.prototype[PropertySymbol.disconnectedFromDocument];
HTMLIFrameElement.prototype[PropertySymbol.disconnectedFromDocument] = function() {
  const disconnect = disconnectors.get(this);
  disconnectors.delete(this);
  try { disconnected.call(this); }
  finally { disconnect?.(); }
};

export function observeFrameDisconnect(element, disconnect) {
  disconnectors.set(element, disconnect);
  return () => {
    // An old context's cleanup must not unregister a reinserted frame.
    if (disconnectors.get(element) === disconnect) disconnectors.delete(element);
  };
}

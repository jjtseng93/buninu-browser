import HTMLElementUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-element/HTMLElementUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {actuallyDisabled} from './form-disabled.js';

// HTML focus fixup at a rendering opportunity. Atomic moves must preserve
// focus synchronously, then blur only if the new rendered context cannot host
// focus. Walk the composed ancestor chain, never the whole document.
export function fixRenderedFocus(document, styleOf, parentOf) {
  const active = document?.[S.activeElement];
  if (!active || !active.isConnected) return false;
  let unfocusable = actuallyDisabled(active);
  const style = styleOf(active);
  unfocusable ||= style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.display === 'contents';
  for (let node = active; node && !unfocusable; node = parentOf(node))
    unfocusable = node.hasAttributeNS?.(null, 'inert') || styleOf(node)?.display === 'none';
  if (!unfocusable) return false;
  HTMLElementUtility.blur(active);
  return document[S.activeElement] !== active;
}

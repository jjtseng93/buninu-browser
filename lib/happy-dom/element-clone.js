import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Namespace prefix is part of an element's identity, independently of its
// qualified tag name. Keep the native clone steps for attributes, descendants
// and specialized HTML elements, including calls made by importNode().
const cloneElement = Element.prototype[S.cloneNode];
Element.prototype[S.cloneNode] = function(deep = false) {
  const clone = cloneElement.call(this, deep);
  clone[S.prefix] = this[S.prefix];
  return clone;
};

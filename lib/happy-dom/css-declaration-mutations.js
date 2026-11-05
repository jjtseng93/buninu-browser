import CSSStyleDeclaration from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/CSSStyleDeclaration.ts';
import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Keep mutation semantics at the shared declaration layer: page bindings,
// native DOM setters and rule declarations all use the same property manager.
const originalSet = CSSStyleDeclaration.prototype.setProperty;
const originalRemove = CSSStyleDeclaration.prototype.removeProperty;
const originalManager = CSSStyleDeclaration.prototype[S.getPropertyManager];
const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
// Inline declarations reflect only the null-namespace style attribute. A
// namespaced attribute with the same qualified name is an unrelated Attr.
CSSStyleDeclaration.prototype[S.getPropertyManager] = function() {
  const element = this[S.element];
  if (!element || this[S.computed]) return originalManager.call(this);
  const cache = this[S.cache], value = element.getAttributeNS(null, 'style') ?? '';
  if (!cache.propertyManager || cache.attributeValue !== value) {
    cache.propertyManager = new CSSPropertyManager({cssText:value});
    cache.attributeValue = value;
  }
  return cache.propertyManager;
};
Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {...cssText, set(value) {
  const element = this[S.element];
  if (!element || this[S.computed]) return cssText.set.call(this, value);
  const manager = new CSSPropertyManager({cssText:String(value)}), serialized = manager.toString();
  this[S.cache].propertyManager = manager;
  this[S.cache].attributeValue = serialized;
  element.setAttributeNS(null, 'style', serialized);
}});
function publish(declaration, manager, before) {
  const after = manager.toString();
  if (after === before) return;
  const element = declaration[S.element];
  if (element) {
    declaration[S.cache].attributeValue = after;
    // An empty declaration is still an existing style attribute. Use one
    // ordinary attribute mutation so observers/reactions see the original value.
    element.setAttributeNS(null, 'style', after);
  }
}
CSSStyleDeclaration.prototype.setProperty = function(name, value, priority = '') {
  if (this[S.computed]) return originalSet.call(this, name, value, priority);
  name = String(name);value = value == null ? '' : String(value);priority = String(priority);
  if (!name.startsWith('--')) name = name.toLowerCase();
  if (value === '') { this.removeProperty(name); return; }
  if (priority && priority.toLowerCase() !== 'important') return;
  const manager = this[S.getPropertyManager](), before = manager.toString();
  manager.set(name, value.trim(), Boolean(priority));
  publish(this, manager, before);
};
CSSStyleDeclaration.prototype.removeProperty = function(name) {
  if (this[S.computed]) return originalRemove.call(this, name);
  name = String(name);
  if (!name.startsWith('--')) name = name.toLowerCase();
  const manager = this[S.getPropertyManager](), before = manager.toString();
  const previous = manager.get(name)?.value ?? '';
  manager.remove(name);
  publish(this, manager, before);
  return previous;
};

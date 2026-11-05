import {trimCSSWhitespace} from '../style/css-value-tokens.js';
import CSSStyleDeclaration from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/CSSStyleDeclaration.ts';
import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Keep mutation semantics at the shared declaration layer: page bindings,
// native DOM setters and rule declarations all use the same property manager.
const originalSet = CSSStyleDeclaration.prototype.setProperty;
const originalRemove = CSSStyleDeclaration.prototype.removeProperty;
const originalManager = CSSStyleDeclaration.prototype[S.getPropertyManager];
const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
// Reflecting a CSSOM change must retain pending substitution records. A direct
// style attribute assignment instead reparses the text, even if identical.
// Consume the marker before invoking hooks so reentrant page mutations are
// treated as external changes, not mistaken for this reflection.
const reflectingStyle=new WeakSet();
const publishedManagers=new WeakSet();
const publicationRevisions=new WeakMap();
export function isCSSOMPublishedManager(manager) {return publishedManagers.has(manager);}
// The vendor's declaration proxy binds setters to its raw target. Both views
// share the cache object, which also survives replacement of its manager.
export function cssDeclarationRevision(declaration) {return publicationRevisions.get(declaration?.[S.cache])??0;}
function markPublished(declaration,manager) {
  publishedManagers.add(manager);
  publicationRevisions.set(declaration[S.cache],cssDeclarationRevision(declaration)+1);
}
// Partially overwritten shorthands have empty public longhands. Their pending
// sources can change without changing cssText, so serialization is not a full
// mutation identity. Keep this transient comparison local to one CSSOM call.
function pendingIdentity(manager) {
  const values=[];
  for(const [name,p] of Object.entries(manager.properties))if(p.pendingBorder||p.overflowSource)
    values.push([name,p.pendingBorder,p.borderSource,p.overflowSource,Boolean(p.important)]);
  return values.length?JSON.stringify(values):'';
}
function reflectStyle(element,value) {
  reflectingStyle.add(element);
  try {element.setAttributeNS(null,'style',value);}finally {reflectingStyle.delete(element);}
}
const setAttribute=Element.prototype[S.onSetAttribute];
Element.prototype[S.onSetAttribute]=function(attribute,replaced) {
  if(attribute[S.namespaceURI]===null&&attribute[S.localName]==='style') {
    const own=reflectingStyle.delete(this),style=this[S.style];
    if(!own&&style) {style[S.cache].propertyManager=null;style[S.cache].attributeValue=null;}
  }
  return setAttribute.call(this,attribute,replaced);
};
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
  if (this[S.computed]) return cssText.set.call(this, value);
  if (!element) {
    cssText.set.call(this,value);
    const manager=this[S.cache].propertyManager;
    if(manager)markPublished(this,manager);
    return;
  }
  const manager = new CSSPropertyManager({cssText:String(value)}), serialized = manager.toString();
  this[S.cache].propertyManager = manager;
  this[S.cache].attributeValue = serialized;
  markPublished(this,manager);
  reflectStyle(element, serialized);
}});
function publish(declaration, manager, before, pendingBefore) {
  const after = manager.toString();
  if (after === before && pendingIdentity(manager)===pendingBefore) return;
  markPublished(declaration,manager);
  const element = declaration[S.element];
  if (element) {
    declaration[S.cache].attributeValue = after;
    // An empty declaration is still an existing style attribute. Use one
    // ordinary attribute mutation so observers/reactions see the original value.
    reflectStyle(element, after);
  }
}
CSSStyleDeclaration.prototype.setProperty = function(name, value, priority = '') {
  if (this[S.computed]) return originalSet.call(this, name, value, priority);
  name = String(name);value = value == null ? '' : String(value);priority = String(priority);
  if (!name.startsWith('--')) name = name.toLowerCase();
  if (value === '') { this.removeProperty(name); return; }
  if (priority && priority.toLowerCase() !== 'important') return;
  const manager = this[S.getPropertyManager](), before = manager.toString(), pendingBefore=pendingIdentity(manager);
  manager.set(name, trimCSSWhitespace(value), Boolean(priority));
  publish(this, manager, before,pendingBefore);
};
CSSStyleDeclaration.prototype.removeProperty = function(name) {
  if (this[S.computed]) return originalRemove.call(this, name);
  name = String(name);
  if (!name.startsWith('--')) name = name.toLowerCase();
  const manager = this[S.getPropertyManager](), before = manager.toString(), pendingBefore=pendingIdentity(manager);
  const previous = manager.get(name)?.value ?? '';
  manager.remove(name);
  publish(this, manager, before,pendingBefore);
  return previous;
};

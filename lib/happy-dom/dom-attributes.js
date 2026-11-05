import Attr from '../../vendor/happy-dom/packages/happy-dom/src/nodes/attr/Attr.ts';
import './node-document-transfer.js';
import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import NamedNodeMap from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/NamedNodeMap.ts';
import NamedNodeMapProxyFactory from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/NamedNodeMapProxyFactory.ts';
import NodeFactory from '../../vendor/happy-dom/packages/happy-dom/src/nodes/NodeFactory.ts';
import MutationRecord from '../../vendor/happy-dom/packages/happy-dom/src/mutation-observer/MutationRecord.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const HTML = 'http://www.w3.org/1999/xhtml';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const lowerASCII = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const htmlDocument = document => document[S.contentType] === 'text/html';
const htmlElement = element => element[S.namespaceURI] === HTML && htmlDocument(element[S.ownerDocument]);
const canonicalElement = element => element?.[S.proxy] || element;
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
const namespaceOf = value => value == null ? null : string(value) || null;

// DOM's attribute rules intentionally allow names that XML historically did
// not. Namespace extraction splits at the first colon only.
// https://dom.spec.whatwg.org/#valid-attribute-local-name
function validateName(name) {
  if (!name || /[\0\t\n\f\r />=]/.test(name)) {
    throw new DOMException('Invalid attribute local name', 'InvalidCharacterError');
  }
}
function extract(namespace, name) {
  const colon = name.indexOf(':');
  const prefix = colon < 0 ? null : name.slice(0, colon);
  const localName = colon < 0 ? name : name.slice(colon + 1);
  if (prefix !== null && (!prefix || /[\0\t\n\f\r />]/.test(prefix))) {
    throw new DOMException('Invalid namespace prefix', 'InvalidCharacterError');
  }
  validateName(localName);
  if ((prefix !== null && namespace === null) ||
      (prefix === 'xml' && namespace !== XML) ||
      ((name === 'xmlns' || prefix === 'xmlns') && namespace !== XMLNS) ||
      (namespace === XMLNS && name !== 'xmlns' && prefix !== 'xmlns')) {
    throw new DOMException('Invalid namespace for attribute name', 'NamespaceError');
  }
  return { namespace, name, prefix, localName };
}
function createAttribute(document, namespace, name, prefix, localName) {
  const attribute = NodeFactory.createNode(document, document[S.window].Attr);
  attribute[S.ownerDocument] = document;
  attribute[S.namespaceURI] = namespace;
  attribute[S.name] = name;
  attribute[S.prefix] = prefix;
  attribute[S.localName] = localName;
  attribute[S.value] = '';
  return attribute;
}

Document.prototype.createAttribute = function (localName) {
  localName = string(localName);
  validateName(localName);
  if (htmlDocument(this)) localName = lowerASCII(localName);
  return createAttribute(this, null, localName, null, localName);
};
Document.prototype.createAttributeNS = function (namespace, qualifiedName) {
  namespace = namespaceOf(namespace);
  qualifiedName = string(qualifiedName);
  const { prefix, localName } = extract(namespace, qualifiedName);
  return createAttribute(this, namespace, qualifiedName, prefix, localName);
};

// Keep the existing element hooks (id maps, forms, style and custom elements),
// while making their mutation records describe the actual namespace/local name.
// Nested attribute changes restore the outer operation before its hook resumes.
let mutation = null;
function notify(element, attribute, previous, remove = false) {
  if (attribute[S.namespaceURI] !== null) {
    // HTML's built-in attribute change steps concern the null namespace only.
    // Arbitrary namespace attributes still notify observers/custom elements.
    const oldValue = remove ? attribute[S.value] : previous?.[S.value] ?? null;
    element[S.reportMutation](new MutationRecord({type: 'attributes', target: element,
      attributeName: attribute[S.localName], attributeNamespace: attribute[S.namespaceURI], oldValue}));
    if (element[S.namespaceURI] === HTML) {
      element[S.window][S.customElementReactionStack].enqueueReaction(element, 'attributeChangedCallback',
        [attribute[S.localName], oldValue, remove ? null : attribute[S.value], attribute[S.namespaceURI]]);
    }
    return;
  }
  const outer = mutation;
  mutation = { element, attribute };
  try {
    if (remove) element[S.onRemoveAttribute](attribute);
    else element[S.onSetAttribute](attribute, previous);
  } finally { mutation = outer; }
}
const reportMutation = Element.prototype[S.reportMutation];
Element.prototype[S.reportMutation] = function (record) {
  if (record.type === 'attributes' && mutation?.element === this && record.attributeNamespace === null) {
    record.attributeName = mutation.attribute[S.localName];
    record.attributeNamespace = mutation.attribute[S.namespaceURI];
  }
  return reportMutation.call(this, record);
};
function changeValue(attribute, value) {
  const element = attribute[S.ownerElement];
  const previous = attribute[S.value] ?? '';
  attribute[S.value] = value;
  if (element) {
    // Hooks need the former value even though the live Attr keeps its identity.
    const old = { [S.value]: previous, value: previous,
      [S.name]: attribute[S.name], name: attribute[S.name] };
    notify(element, attribute, old);
  }
}
for (const property of ['value', 'nodeValue', 'textContent']) {
  Object.defineProperty(Attr.prototype, property, { configurable: true, enumerable: true,
    get() { return this[S.value] ?? ''; },
    set(value) { changeValue(this, property !== 'value' && value == null ? '' : string(value)); },
  });
}
Object.defineProperty(Attr.prototype, 'nodeName', { configurable: true, enumerable: true,
  get() { return this[S.name] ?? ''; },
});
Object.defineProperty(Attr.prototype, 'ownerElement', { configurable: true, enumerable: true,
  get() { return canonicalElement(this[S.ownerElement]); },
});
const cloneAttribute = Attr.prototype[S.cloneNode];
Attr.prototype[S.cloneNode] = function (deep) {
  const clone = cloneAttribute.call(this, deep);
  clone[S.ownerDocument] = this[S.ownerDocument];
  return clone;
};

// A tuple key cannot confuse colons inside a namespace with colons inside a
// local name. Map.set replaces in place and preserves the attribute list order.
const keyOf = (namespace, localName) => JSON.stringify([namespace, localName]);
const attributeKey = attribute => keyOf(attribute[S.namespaceURI], attribute[S.localName]);
function refreshName(map, name) {
  const items = [];
  for (const attribute of map[S.items].values()) {
    if (attribute[S.name] === name) items.push(attribute);
  }
  if (items.length) map[S.itemsByName].set(name, items);
  else map[S.itemsByName].delete(name);
}
NamedNodeMap.prototype.getNamedItemNS = function (namespace, localName) {
  namespace = namespaceOf(namespace);
  localName = string(localName);
  return this[S.itemsByNamespaceURI].get(keyOf(namespace, localName)) ?? null;
};
NamedNodeMap.prototype[S.setNamedItem] = function (attribute, ignoreListeners = false) {
  const element = this[S.ownerElement];
  if (attribute[S.ownerElement] !== null && canonicalElement(attribute[S.ownerElement]) !== canonicalElement(element)) {
    throw new DOMException('The attribute is in use', 'InUseAttributeError');
  }
  const key = attributeKey(attribute);
  const previous = this[S.itemsByNamespaceURI].get(key) ?? null;
  if (previous === attribute) return attribute;
  attribute[S.ownerDocument] = element[S.ownerDocument];
  attribute[S.ownerElement] = element;
  this[S.items].set(key, attribute);
  this[S.itemsByNamespaceURI].set(key, attribute);
  if (previous) {
    previous[S.ownerElement] = null;
    refreshName(this, previous[S.name]);
  }
  refreshName(this, attribute[S.name]);
  if (!ignoreListeners) notify(element, attribute, previous);
  return previous;
};
NamedNodeMap.prototype[S.removeNamedItem] = function (attribute, ignoreListeners = false) {
  const key = attributeKey(attribute);
  this[S.items].delete(key);
  this[S.itemsByNamespaceURI].delete(key);
  refreshName(this, attribute[S.name]);
  attribute[S.ownerElement] = null;
  if (!ignoreListeners) notify(this[S.ownerElement], attribute, null, true);
};
for (const [method, get] of [['removeNamedItem', 'getNamedItem'], ['removeNamedItemNS', 'getNamedItemNS']]) {
  NamedNodeMap.prototype[method] = function (...args) {
    const attribute = this[get](...args);
    if (!attribute) throw new DOMException('The attribute was not found', 'NotFoundError');
    this[S.removeNamedItem](attribute);
    return attribute;
  };
}

// The tree builder's collection proxy must expose attribute names, never the
// internal tuple keys. Named properties cannot shadow prototype methods.
NamedNodeMapProxyFactory.createProxy = function (map) {
  const indexOf = property => typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)
    && Number(property) < 0xffffffff ? Number(property) : -1;
  const named = property => typeof property === 'string' && !(property in map)
    && (!htmlElement(map[S.ownerElement]) || lowerASCII(property) === property)
    ? map[S.itemsByName].get(property)?.[0] : undefined;
  let proxy;
  proxy = new Proxy(map, {
    get(target, property, receiver) {
      if (property in target || typeof property === 'symbol') return Reflect.get(target, property, receiver);
      const index = indexOf(property);
      return index >= 0 ? target.item(index) ?? undefined : named(property);
    },
    has(target, property) {
      const index = indexOf(property);
      return property in target || (index >= 0 && index < target.length) || !!named(property);
    },
    ownKeys(target) {
      const names = [...target[S.itemsByName].keys()].filter(name => named(name));
      return [...new Set([...Array.from({length:target.length}, (_, i) => String(i)), ...names,
        ...Reflect.ownKeys(target)])];
    },
    getOwnPropertyDescriptor(target, property) {
      const own = Reflect.getOwnPropertyDescriptor(target, property);
      if (own) return own;
      const index = indexOf(property), value = index >= 0 ? target.item(index) : named(property);
      if (value) return { value, writable: false, enumerable: index >= 0, configurable: true };
    },
    set(target, property, value, receiver) {
      if (receiver === proxy && (indexOf(property) >= 0 || named(property))) return false;
      return Reflect.set(target, property, value, receiver);
    },
    defineProperty(target, property, descriptor) {
      if (indexOf(property) >= 0 || named(property)) return false;
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      const index = indexOf(property);
      if ((index >= 0 && index < target.length) || named(property)) return false;
      return Reflect.deleteProperty(target, property);
    },
    preventExtensions() { return false; },
  });
  return proxy;
};

Element.prototype.setAttribute = function (name, value) {
  name = string(name);
  value = string(value);
  validateName(name);
  if (htmlElement(this)) name = lowerASCII(name);
  const map = this[S.attributes], current = map.getNamedItem(name);
  if (current) changeValue(current, value);
  else {
    const attribute = createAttribute(this[S.ownerDocument], null, name, null, name);
    attribute[S.value] = value;
    map[S.setNamedItem](attribute);
  }
};
Element.prototype.setAttributeNS = function (namespace, name, value) {
  namespace = namespaceOf(namespace);
  name = string(name);
  value = string(value);
  const { prefix, localName } = extract(namespace, name);
  const map = this[S.attributes], current = map.getNamedItemNS(namespace, localName);
  if (current) changeValue(current, value);
  else {
    const attribute = createAttribute(this[S.ownerDocument], namespace, name, prefix, localName);
    attribute[S.value] = value;
    map[S.setNamedItem](attribute);
  }
};
Element.prototype.toggleAttribute = function (name, force) {
  name = string(name);
  const forced = force === undefined ? undefined : Boolean(force);
  validateName(name);
  if (htmlElement(this)) name = lowerASCII(name);
  const map = this[S.attributes], current = map.getNamedItem(name);
  if (current) {
    if (forced === true) return true;
    map[S.removeNamedItem](current);
    return false;
  }
  if (forced === false) return false;
  const attribute = createAttribute(this[S.ownerDocument], null, name, null, name);
  map[S.setNamedItem](attribute);
  return true;
};
Element.prototype.removeAttributeNode = function (attribute) {
  if (canonicalElement(attribute[S.ownerElement]) !== canonicalElement(this)) {
    throw new DOMException('The attribute was not found', 'NotFoundError');
  }
  this[S.attributes][S.removeNamedItem](attribute);
  return attribute;
};

import './dom-attributes.js';
import './cdata-section.js';
import Node from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts';
import CharacterData from '../../vendor/happy-dom/packages/happy-dom/src/nodes/character-data/CharacterData.ts';
import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import DocumentFragment from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document-fragment/DocumentFragment.ts';
import Attr from '../../vendor/happy-dom/packages/happy-dom/src/nodes/attr/Attr.ts';
import {encodingString} from '../renderer/encoding-string.js';
import {stringReplaceAll} from './node-replace-all.js';

const nativeError = (_name, message) => new TypeError(message);

// CharacterData.data is [LegacyNullToEmptyString] DOMString, whereas the
// Node properties are nullable DOMString. Only the latter maps undefined to
// null (and then to empty text). Objects are converted with the string hint;
// an object returning null is the string "null", not a null IDL value.
export const characterDataString = (value, error = nativeError) =>
  value === null ? '' : encodingString(value, error);
export const nodeTextString = (value, error = nativeError) =>
  value == null ? '' : encodingString(value, error);

const data = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
Object.defineProperty(CharacterData.prototype, 'data', {...data, set(value) {
  if (!(this instanceof CharacterData)) throw new TypeError('Illegal invocation');
  // Reuse mutation reporting. Text's overriding setter still updates its
  // textarea selection and style sheet after calling this base setter.
  data.set.call(this, characterDataString(value));
}});

const nodeDescriptors = new Map();
for (const [prototype, properties, types] of [
  [CharacterData.prototype, ['nodeValue', 'textContent'], [3, 4, 7, 8]],
  [Attr.prototype, ['nodeValue', 'textContent'], [2]],
  [Element.prototype, ['textContent'], [1]],
  [DocumentFragment.prototype, ['textContent'], [11]],
]) for (const property of properties) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
  const replacement = {...descriptor,
    set(value) {
      if (!(this instanceof Node)) throw new TypeError('Illegal invocation');
      value = nodeTextString(value);
      if (property === 'textContent' && (types[0] === 1 || types[0] === 11)) stringReplaceAll(this, value);
      else descriptor.set.call(this, value);
    },
  };
  for (const type of types) nodeDescriptors.set(`${type}:${property}`, replacement);
  Object.defineProperty(prototype, property, replacement);
}

// Node's own descriptors also work when borrowed by an Element, Attr or
// CharacterData. Document and DocumentType return null, with no mutation;
// their setter still performs the WebIDL conversion first.
for (const property of ['nodeValue', 'textContent']) {
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, property);
  const target = node => {
    if (!(node instanceof Node)) throw new TypeError('Illegal invocation');
    return nodeDescriptors.get(`${node.nodeType}:${property}`);
  };
  Object.defineProperty(Node.prototype, property, {...descriptor,
    get() { return target(this)?.get.call(this) ?? null; },
    set(value) {
      const selected = target(this);
      value = nodeTextString(value);
      selected?.set.call(this, value);
    },
  });
}

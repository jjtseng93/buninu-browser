import { encodingString } from './encoding-string.js';
import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

// HTML's legacy factory creates a real option in the associated document.
// Its prototype is HTMLOptionElement.prototype; the factory is not the
// interface constructor, and subclasses still select their NewTarget prototype.
export function optionConstructor(document, realm, optionPrototype, global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  function Option() { throw error('TypeError', 'Option requires new'); }
  Object.defineProperty(Option, 'prototype', { value: optionPrototype, writable: false });
  // A construct trap avoids allocating an unused JS receiver (which would
  // look up a Proxy NewTarget's prototype before we look it up again).
  return new Proxy(Option, { construct(_target, args, newTarget) {
    let [text = '', value = undefined, defaultSelected = false, selected = false] = args;
    text = encodingString(text, error);
    if (value !== undefined) value = encodingString(value, error);
    defaultSelected = Boolean(defaultSelected);
    selected = Boolean(selected);
    const prototype = newTarget.prototype;
    const option = document.createElement('option');
    if (text !== '') option.appendChild(document.createTextNode(text));
    if (value !== undefined) option.setAttribute('value', value);
    if (defaultSelected) option.setAttribute('selected', '');
    // Unlike the selected IDL setter, the constructor does not dirty the
    // selectedness flag. Later selected-attribute changes must still apply.
    option[PropertySymbol.selectedness] = selected;
    const wrapper = realm.wrap(option);
    Object.setPrototypeOf(wrapper, object(prototype) ? prototype : optionPrototype);
    return wrapper;
  } });
}

import {formControls, fieldsetControls} from '../happy-dom/form-association.js';
import {encodingString} from './encoding-string.js';

const html = 'http://www.w3.org/1999/xhtml';
const isRadio = node => node.namespaceURI === html && node.localName === 'input' && node.type === 'radio';
const matches = (node, name) => node.getAttributeNS(null, 'id') === name || node.getAttributeNS(null, 'name') === name;
const collections = new WeakMap(), radios = new WeakMap();

// Use the same live indexed objects as ordinary HTMLCollection/NodeList.
// RadioNodeList is only a view: it owns no controls or checkedness state.
export function formControlsInterface({base, lists, wrap, changed, global = () => globalThis}) {
  const views = new WeakMap();
  const error = message => new (global().TypeError)(message);
  const stateOf = (states, self) => {
    const state = states.get(self);
    if (!state) throw error('Illegal invocation');
    return state;
  };
  function RadioNodeList() { throw error('Illegal constructor'); }
  Object.setPrototypeOf(RadioNodeList, lists.NodeList);
  RadioNodeList.prototype = Object.create(lists.NodeList.prototype);
  Object.defineProperties(RadioNodeList.prototype, {
    constructor:{value:RadioNodeList, writable:true, configurable:true},
    value:{get() {
      return stateOf(radios, this).query().find(node => isRadio(node) && node.checked)?.value ?? '';
    }, set(value) {
      const state = stateOf(radios, this);
      value = encodingString(value, (_name, message) => error(message));
      const radio = state.query().find(node => isRadio(node) && node.value === value);
      if (radio) { radio.checked = true; state.changed(radio); }
    }, enumerable:true, configurable:true},
    [Symbol.toStringTag]:{value:'RadioNodeList', configurable:true},
  });
  Object.defineProperty(RadioNodeList, 'prototype', {writable:false});

  function named(query, name) {
    if (!name) return null;
    const matching = () => query().filter(node => matches(node, name));
    const nodes = matching();
    if (!nodes.length) return null;
    if (nodes.length === 1) return wrap(nodes[0]);
    const view = lists.create(matching, wrap, {prototype:RadioNodeList.prototype});
    radios.set(view, {query:matching, changed});
    return view;
  }

  function HTMLFormControlsCollection() { throw error('Illegal constructor'); }
  Object.setPrototypeOf(HTMLFormControlsCollection, base.HTMLCollection);
  HTMLFormControlsCollection.prototype = Object.create(base.HTMLCollection.prototype);
  Object.defineProperties(HTMLFormControlsCollection.prototype, {
    constructor:{value:HTMLFormControlsCollection, writable:true, configurable:true},
    namedItem:{value:function namedItem(name) {
      const state = stateOf(collections, this);
      if (!arguments.length) throw error('namedItem requires a name');
      return state.named(encodingString(name, (_name, message) => error(message)));
    }, enumerable:true, configurable:true, writable:true},
    [Symbol.toStringTag]:{value:'HTMLFormControlsCollection', configurable:true},
  });
  Object.defineProperty(HTMLFormControlsCollection, 'prototype', {writable:false});

  return {HTMLFormControlsCollection, RadioNodeList, create(element) {
    let view = views.get(element);
    if (view) return view;
    const isForm = element.localName === 'form';
    const query = () => isForm ? formControls(element) : fieldsetControls(element);
    view = base.create(query, wrap, isForm ? {prototype:HTMLFormControlsCollection.prototype,
      named:name => named(query, name)} : {});
    if (isForm) collections.set(view, {named:name => named(query, name)});
    views.set(element, view);
    return view;
  }};
}

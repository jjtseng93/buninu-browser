import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-element/HTMLElement.ts';
import ValidityState from '../../vendor/happy-dom/packages/happy-dom/src/validity-state/ValidityState.ts';
import MouseEvent from '../../vendor/happy-dom/packages/happy-dom/src/event/events/MouseEvent.ts';
import Event from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const html = 'http://www.w3.org/1999/xhtml';
const isRadio = element => element?.namespaceURI === html && element.localName === 'input' && element.type === 'radio';
const groupName = element => element.getAttributeNS(null, 'name') ?? '';
const identity = node => node?.[S.proxy] ?? node;
const dirty = new WeakSet();

export function formOwner(control) {
  const id = control.getAttributeNS(null, 'form');
  if (id !== null && control.isConnected) {
    const owner = control.getRootNode().getElementById(id);
    return owner?.namespaceURI === html && owner.localName === 'form' ? identity(owner) : null;
  }
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    if (parent.namespaceURI === html && parent.localName === 'form') return identity(parent);
  }
  return null;
}

// HTML radio groups use the same tree, form owner and nonempty case-sensitive
// name. Compare names directly: they are arbitrary strings, not CSS syntax.
export function radioGroup(control) {
  const name = groupName(control);
  if (!name) return [control];
  const root = control.getRootNode(), owner = formOwner(control);
  const group = [];
  if (isRadio(root) && groupName(root) === name && formOwner(root) === owner) group.push(root);
  for (const peer of root.querySelectorAll('input')) {
    if (isRadio(peer) && groupName(peer) === name && formOwner(peer) === owner) group.push(peer);
  }
  return group;
}

function storeChecked(control, checked) {
  if (control.checked === checked && control[S.checked] !== null) return;
  control[S.checked] = checked;
  control[S.clearCache]();
}

function excludePeers(control) {
  if (!isRadio(control) || !control.checked) return;
  for (const peer of radioGroup(control)) if (peer !== control && peer.checked) storeChecked(peer, false);
}

const checked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
Object.defineProperty(HTMLInputElement.prototype, 'checked', { ...checked, set(value) {
  dirty.add(this);
  if (!isRadio(this)) return checked.set.call(this, Boolean(value));
  storeChecked(this, Boolean(value));
  excludePeers(this);
} });

const missing = Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing');
Object.defineProperty(ValidityState.prototype, 'valueMissing', { ...missing, get() {
  if (!isRadio(this.element)) return missing.get.call(this);
  let required = false;
  for (const peer of radioGroup(this.element)) {
    if (peer.checked) return false;
    required ||= peer.hasAttributeNS(null, 'required');
  }
  // Disabled members still count for both required and checkedness; whether
  // this particular control can block submission is decided by willValidate.
  return required;
} });

for (const symbol of [S.onSetAttribute, S.onRemoveAttribute]) {
  const original = HTMLInputElement.prototype[symbol];
  HTMLInputElement.prototype[symbol] = function(attribute, ...args) {
    const result = original.call(this, attribute, ...args);
    if (!isRadio(this) || attribute[S.namespaceURI] !== null) return result;
    const name = attribute[S.name];
    if (name === 'checked') {
      // Form reset restores the vendor slot to null, clearing checked dirtiness.
      if (this[S.checked] === null) dirty.delete(this);
      if (!dirty.has(this)) storeChecked(this, this.hasAttributeNS(null, 'checked'));
    }
    if (['checked', 'type', 'name', 'form'].includes(name)) excludePeers(this);
    return result;
  };
}

const connected = HTMLInputElement.prototype[S.connectedToNode];
HTMLInputElement.prototype[S.connectedToNode] = function(...args) {
  const result = connected.apply(this, args);
  // Insertion into an unowned disconnected tree does not deselect its other
  // radios. Explicit checked assignments still group that tree normally.
  if (this.isConnected || formOwner(this)) excludePeers(this);
  return result;
};

const dispatch = HTMLInputElement.prototype.dispatchEvent;
HTMLInputElement.prototype.dispatchEvent = function(event) {
  if (!isRadio(this) || event[S.type] !== 'click' || event[S.eventPhase] !== 0 || !(event instanceof MouseEvent))
    return dispatch.call(this, event);
  if (this.disabled) return false;
  const wasChecked = this.checked;
  const previous = radioGroup(this).find(peer => peer.checked) ?? null;
  this.checked = true;
  const result = HTMLElement.prototype.dispatchEvent.call(this, event);
  if (event.defaultPrevented) {
    if (previous && isRadio(previous) && radioGroup(this).includes(previous)) previous.checked = true;
    else this.checked = false;
  } else if (!wasChecked && this.isConnected) {
    for (const type of ['input', 'change']) {
      const generated = new Event(type, { bubbles: true, composed: type === 'input' });
      this.dispatchEvent(generated);
    }
  }
  return result;
};

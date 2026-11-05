import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';
import HTMLSelectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts';
import HTMLButtonElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-button-element/HTMLButtonElement.ts';

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const isHTML = (element, name) => element.namespaceURI === htmlNamespace && element.localName === name;

// Constraint validation uses DOM ancestors, not shadow-including ancestors.
// Each disabled fieldset exempts only descendants of its first legend child;
// exemption from one fieldset does not exempt a control from outer fieldsets.
function barredByAncestor(element) {
  let branch = element;
  for (let parent = element.parentElement; parent; branch = parent, parent = parent.parentElement) {
    if (isHTML(parent, 'datalist')) return true;
    if (!isHTML(parent, 'fieldset') || !parent.disabled) continue;
    let legend = parent.firstElementChild;
    while (legend && !isHTML(legend, 'legend')) legend = legend.nextElementSibling;
    if (legend !== branch) return true;
  }
  return false;
}

for (const Type of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement]) {
  const eligibility = Object.getOwnPropertyDescriptor(Type.prototype, 'willValidate');
  Object.defineProperty(Type.prototype, 'willValidate', { ...eligibility, get() {
    if (!eligibility.get.call(this)) return false;
    if (Type === HTMLButtonElement && (this.type === 'button' || this.type === 'reset')) return false;
    return !barredByAncestor(this);
  } });

  const check = Object.getOwnPropertyDescriptor(Type.prototype, 'checkValidity');
  Object.defineProperty(Type.prototype, 'checkValidity', { ...check, value(...args) {
    return !this.willValidate || check.value.apply(this, args);
  } });
  const message = Object.getOwnPropertyDescriptor(Type.prototype, 'validationMessage');
  Object.defineProperty(Type.prototype, 'validationMessage', { ...message, get() {
    return this.willValidate ? message.get.call(this) : '';
  } });
}

import HTMLFormElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-form-element/HTMLFormElement.ts';
import HTMLOutputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-output-element/HTMLOutputElement.ts';
import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLSelectElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-select-element/HTMLSelectElement.ts';
import HTMLOptionElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-option-element/HTMLOptionElement.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { formOwner, resetChecked } from './radio-groups.js';
import { markEventTrusted } from './event-state.js';
import { resetTextControlEditState } from './text-control-edit-state.js';

const html = 'http://www.w3.org/1999/xhtml';
const resetting = new WeakSet();
for (const [Type, property, attribute] of [[HTMLInputElement, 'defaultChecked', 'checked'], [HTMLOptionElement, 'defaultSelected', 'selected']]) {
  Object.defineProperty(Type.prototype, property, { configurable: true, enumerable: true,
    get() { return this.hasAttributeNS(null, attribute); },
    set(value) {
      if (value) this.setAttributeNS(null, attribute, '');
      else this.removeAttributeNS(null, attribute);
    },
  });
}
const selectedIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', { ...selectedIndex,
  get() { return Array.prototype.findIndex.call(this.options, option => option.selected); },
});
// Missing entries mean output's default-value mode: its default follows DOM
// text edits. Setting .value enters value mode and saves the previous default.
const outputDefaults = new WeakMap();
Object.defineProperties(HTMLOutputElement.prototype, {
  defaultValue: { configurable: true, enumerable: true,
    get() { return outputDefaults.has(this) ? outputDefaults.get(this) : this.textContent; },
    set(value) {
      value = `${value}`;
      if (outputDefaults.has(this)) outputDefaults.set(this, value);
      else this.textContent = value;
    },
  },
  value: { configurable: true, enumerable: true,
    get() { return this.textContent; },
    set(value) {
      value = `${value}`;
      if (!outputDefaults.has(this)) outputDefaults.set(this, this.textContent);
      this.textContent = value;
    },
  },
});

HTMLFormElement.prototype.reset = function() {
  const form = this[S.proxy] ?? this;
  if (resetting.has(form)) return;
  resetting.add(form);
  try {
    const event = markEventTrusted(new this[S.window].Event('reset', { bubbles: true, cancelable: true }));
    if (!this.dispatchEvent(event)) return;
    // The event may have moved controls or changed their form attributes.
    // Resolve ownership only after it completes, including external controls.
    for (const control of this.getRootNode().querySelectorAll('input,select,textarea,output')) {
      if (control.namespaceURI !== html || formOwner(control) !== form) continue;
      switch (control.localName) {
        case 'input':
          if (control.type === 'file') control.value = '';
          control[S.value] = null;
          resetTextControlEditState(control);
          resetChecked(control);
          break;
        case 'textarea':
          control[S.value] = null;
          resetTextControlEditState(control);
          break;
        case 'select': {
          const options = [...control.options];
          for (const option of options) {
            option[S.dirtyness] = false;
            option[S.selectedness] = option.hasAttributeNS(null, 'selected');
            option[S.clearCache]();
          }
          if (!control.hasAttributeNS(null, 'multiple')) {
            const selected = options.filter(option => option.selected);
            // A single select preserves the last default-selected option.
            const chosen = selected.at(-1) ?? ((control.size || 1) === 1
              ? options.find(option => !option.hasAttributeNS(null, 'disabled')
                && !(option.parentElement?.localName === 'optgroup' && option.parentElement.hasAttributeNS(null, 'disabled')))
              : null);
            for (const option of options) option[S.selectedness] = option === chosen;
          }
          control[S.selectedIndex] = options.findIndex(option => option.selected);
          break;
        }
        case 'output': {
          const value = control.defaultValue;
          outputDefaults.delete(control);
          control.textContent = value;
          break;
        }
      }
      control[S.clearCache]();
    }
  } finally { resetting.delete(form); }
};

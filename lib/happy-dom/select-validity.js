import ValidityState from '../../vendor/happy-dom/packages/happy-dom/src/validity-state/ValidityState.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {selectDisplaySize} from './select-options.js';

// A required select asks for a selected option, not necessarily a nonempty
// value. Only the first placeholder of a single-row dropdown is excluded;
// later empty options, optgroup members and disabled selections remain valid.
// Retain Chromium's multiple-select behavior even for an explicit size=1.
const missing = Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing');
Object.defineProperty(ValidityState.prototype, 'valueMissing', { ...missing, get() {
  const select = this.element?.[S.proxy] ?? this.element;
  if (select?.namespaceURI !== 'http://www.w3.org/1999/xhtml' || select.localName !== 'select')
    return missing.get.call(this);
  if (!select.hasAttributeNS(null, 'required')) return false;
  const options = select.options;
  const first = options[0];
  let placeholder = !select.hasAttributeNS(null, 'multiple') && selectDisplaySize(select) === 1
    && first?.value === '' ? first : null;
  // Ordinary wrapper elements do not turn the first empty option into a
  // real choice. Only an intervening HTML optgroup excludes the placeholder.
  for (let parent = placeholder?.parentElement; parent && parent !== select; parent = parent.parentElement) {
    if (parent.namespaceURI === 'http://www.w3.org/1999/xhtml' && parent.localName === 'optgroup') { placeholder = null; break; }
  }
  for (const option of options) if (option[S.selectedness] && option !== placeholder) return false;
  return true;
} });

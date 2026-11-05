// HTML disabledness is an inherited state, distinct from the reflected
// .disabled attribute. Keep selection's option-disabled algorithm separate
// from :disabled, which also observes the nearest select's disabledness.
const HTML = 'http://www.w3.org/1999/xhtml';
const names = new Set(['button', 'input', 'select', 'textarea', 'fieldset', 'optgroup', 'option']);
export const supportsDisabled = element => element?.namespaceURI === HTML && names.has(element.localName);
const isHTML = (element, name) => element?.namespaceURI === HTML && element.localName === name;
const ownDisabled = element => element.hasAttributeNS(null, 'disabled');

export function disabledByFieldset(element) {
  let branch = element;
  for (let parent = element.parentElement; parent; branch = parent, parent = parent.parentElement) {
    if (!isHTML(parent, 'fieldset') || !ownDisabled(parent)) continue;
    let legend = parent.firstElementChild;
    while (legend && !isHTML(legend, 'legend')) legend = legend.nextElementSibling;
    if (branch !== legend) return true;
  }
  return false;
}

export function optionDisabled(option) {
  if (ownDisabled(option)) return true;
  for (let parent = option.parentElement; parent; parent = parent.parentElement) {
    if (parent.namespaceURI !== HTML) continue;
    if (['select', 'hr', 'datalist', 'option'].includes(parent.localName)) return false;
    if (parent.localName === 'optgroup') return ownDisabled(parent);
  }
  return false;
}

export function actuallyDisabled(element) {
  if (!supportsDisabled(element)) return false;
  if (element.localName !== 'option' && element.localName !== 'optgroup')
    return ownDisabled(element) || disabledByFieldset(element);
  if (element.localName === 'option' ? optionDisabled(element) : ownDisabled(element)) return true;
  // HTML's actual-disabled definition includes the nearest select (2026),
  // without making select.disabled affect the option selectedness algorithm.
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (isHTML(parent, 'select')) return actuallyDisabled(parent);
  return false;
}

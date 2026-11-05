import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Textarea's default/raw value uses child text content, not descendant text
// content. CDATA is Text too; comments, PIs and element descendants contribute
// nothing. Concatenate before the API getter normalizes CRLF across nodes.
export function textareaDefaultValue(element) {
  const parts = [];
  for (const child of element[S.nodeArray]) {
    if (child.nodeType === 3 || child.nodeType === 4) parts.push(child.data);
  }
  return parts.join('');
}

export function textareaRawValue(element) {
  return element[S.value] === null ? textareaDefaultValue(element) : element[S.value];
}

Object.defineProperty(HTMLTextAreaElement.prototype, 'defaultValue', {
  configurable: true, enumerable: true,
  get() { return textareaDefaultValue(this); },
  set(value) { this.textContent = `${value}`; },
});

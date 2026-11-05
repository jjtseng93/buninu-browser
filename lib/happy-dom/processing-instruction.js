import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import ProcessingInstruction from '../../vendor/happy-dom/packages/happy-dom/src/nodes/processing-instruction/ProcessingInstruction.ts';
import NodeFactory from '../../vendor/happy-dom/packages/happy-dom/src/nodes/NodeFactory.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// DOM's processing-instruction target still uses XML 1.0 Name, unlike its
// newer, deliberately looser element/attribute local-name rules.
// https://www.w3.org/TR/xml/#NT-Name
const start = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF'
  + '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const name = new RegExp(`^[${start}][${start}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`, 'u');
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
  return String(value);
}

Document.prototype.createProcessingInstruction = function(target, data) {
  if (arguments.length < 2) throw new TypeError('createProcessingInstruction requires two arguments');
  target = string(target);
  data = string(data);
  if (!name.test(target) || data.includes('?>')) {
    throw new DOMException('Invalid processing instruction target or data', 'InvalidCharacterError');
  }
  const instruction = NodeFactory.createNode(this, this[S.window].ProcessingInstruction);
  instruction[S.ownerDocument] = this;
  instruction[S.target] = target;
  instruction[S.data] = data;
  return instruction;
};

Object.defineProperty(ProcessingInstruction.prototype, 'nodeName', {
  configurable: true, get() { return this[S.target]; },
});
const cloneNode = ProcessingInstruction.prototype[S.cloneNode];
ProcessingInstruction.prototype[S.cloneNode] = function(deep = false) {
  const clone = cloneNode.call(this, deep);
  clone[S.ownerDocument] = this[S.ownerDocument];
  clone[S.target] = this[S.target];
  return clone;
};

import Range from '../../vendor/happy-dom/packages/happy-dom/src/range/Range.ts';
import RangeUtility from '../../vendor/happy-dom/packages/happy-dom/src/range/RangeUtility.ts';
import NodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/NodeUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// DOM ranges belong to an ordinary tree, not to every node with the same
// ownerDocument. In particular Attrs, detached nodes and ShadowRoots each
// have their own root. Never cross a shadow host when comparing boundaries.
// https://dom.spec.whatwg.org/#concept-range-bp-set
function root(node) {
  while (node[S.parentNode]) node = node[S.parentNode];
  return node;
}
const compare = (a, b) => RangeUtility.compareBoundaryPointsPosition(a, b);
function validate(node, offset) {
  if (node[S.nodeType] === 10) throw new DOMException('DocumentType cannot be a boundary point', 'InvalidNodeTypeError');
  if (offset > NodeUtility.getNodeLength(node)) throw new DOMException('Offset exceeds node length', 'IndexSizeError');
}
function point(range, side) {
  return {node: range[side].node, offset: side === S.start ? range.startOffset : range.endOffset};
}
function synchronizeDocument(range) {
  const node = range[S.start].node;
  range[S.ownerDocument] = node[S.nodeType] === 9 ? node : node[S.ownerDocument];
}

for (const [method, side, opposite, direction] of [
  ['setStart', S.start, S.end, 1], ['setEnd', S.end, S.start, -1],
]) Range.prototype[method] = function(node, offset = 0) {
  validate(node, offset);
  const boundary = {node, offset};
  if (root(node) !== root(this[S.start].node) || compare(boundary, point(this, opposite)) === direction)
    this[opposite] = {...boundary};
  this[side] = boundary;
  synchronizeDocument(this);
};

for (const method of ['selectNode', 'selectNodeContents']) {
  const original = Range.prototype[method];
  Range.prototype[method] = function(node) {
    original.call(this, node);
    synchronizeDocument(this);
  };
}
const cloneRange = Range.prototype.cloneRange;
Range.prototype.cloneRange = function() {
  const clone = cloneRange.call(this);
  synchronizeDocument(clone);
  return clone;
};
// A detached root can be adopted after the last boundary setter. Fragment
// creation must use its current document, rather than the construction cache.
for (const method of ['cloneContents', 'extractContents']) {
  const original = Range.prototype[method];
  Range.prototype[method] = function() {
    synchronizeDocument(this);
    return original.call(this);
  };
}

Range.prototype.comparePoint = function(node, offset) {
  if (root(node) !== root(this[S.start].node)) throw new DOMException('Point and Range have different roots', 'WrongDocumentError');
  validate(node, offset);
  const boundary = {node, offset};
  return compare(boundary, point(this, S.start)) < 0 ? -1
    : compare(boundary, point(this, S.end)) > 0 ? 1 : 0;
};
Range.prototype.isPointInRange = function(node, offset = 0) {
  if (root(node) !== root(this[S.start].node)) return false;
  validate(node, offset);
  const boundary = {node, offset};
  return compare(boundary, point(this, S.start)) >= 0 && compare(boundary, point(this, S.end)) <= 0;
};
Range.prototype.intersectsNode = function(node) {
  if (root(node) !== root(this[S.start].node)) return false;
  const parent = node[S.parentNode];
  if (!parent) return true;
  const index = parent[S.nodeArray].indexOf(node);
  return compare({node: parent, offset: index}, point(this, S.end)) < 0
    && compare({node: parent, offset: index + 1}, point(this, S.start)) > 0;
};
const boundarySides = [[S.start, S.start], [S.end, S.start], [S.end, S.end], [S.start, S.end]];
Range.prototype.compareBoundaryPoints = function(how, other) {
  if (!Number.isInteger(how) || how < 0 || how > 3) throw new DOMException('Unknown boundary comparison', 'NotSupportedError');
  if (root(this[S.start].node) !== root(other[S.start].node)) throw new DOMException('Ranges have different roots', 'WrongDocumentError');
  const [left, right] = boundarySides[how];
  return compare(point(this, left), point(other, right));
};

// Reject invalid node kinds before the vendored insertion can detach an
// argument or split the boundary Text. Attrs can contain a collapsed Range,
// but are neither valid insertion parents nor valid inserted children.
const insertNode = Range.prototype.insertNode;
Range.prototype.insertNode = function(node) {
  const start = this[S.start].node;
  if (![1, 3, 4, 7, 8, 10, 11].includes(node[S.nodeType]) || start[S.nodeType] === 2)
    throw new DOMException('Invalid Range insertion node', 'HierarchyRequestError');
  return insertNode.call(this, node);
};

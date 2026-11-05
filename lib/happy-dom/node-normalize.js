import Node from '../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts';
import Document from '../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts';
import Text from '../../vendor/happy-dom/packages/happy-dom/src/nodes/text/Text.ts';
import Range from '../../vendor/happy-dom/packages/happy-dom/src/range/Range.ts';
import Selection from '../../vendor/happy-dom/packages/happy-dom/src/selection/Selection.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// The vendored DOM has no live-range mutation registry. Keep weak references
// only: a retained range must follow normalization, but must never keep its
// page or detached tree alive merely because it once had a boundary set.
const ranges = new Set(), registered = new WeakSet();
const cleanup = new FinalizationRegistry(ref => ranges.delete(ref));
function track(range) {
  if (!registered.has(range)) {
    const ref = new WeakRef(range);
    registered.add(range); ranges.add(ref); cleanup.register(range, ref);
  }
  return range;
}
for (const name of ['setStart', 'setEnd', 'selectNode', 'selectNodeContents', 'collapse']) {
  const method = Range.prototype[name];
  Range.prototype[name] = function(...args) {
    const result = method.apply(this, args);
    track(this);
    return result;
  };
}
const cloneRange = Range.prototype.cloneRange;
Range.prototype.cloneRange = function() { return track(cloneRange.call(this)); };
const getRangeAt = Selection.prototype.getRangeAt;
Selection.prototype.getRangeAt = function(index) { return track(getRangeAt.call(this, index)); };
const selections = new Set(), knownSelections = new WeakSet();
const selectionCleanup = new FinalizationRegistry(ref => selections.delete(ref));
const getSelection = Document.prototype.getSelection;
Document.prototype.getSelection = function() {
  const selection = getSelection.call(this);
  if (!knownSelections.has(selection)) {
    const ref = new WeakRef(selection);
    knownSelections.add(selection); selections.add(ref); selectionCleanup.register(selection, ref);
  }
  return selection;
};

function liveBoundaries() {
  // Selection constructs ranges internally without calling their setters.
  // Read its current range here, including during a synchronous selectionchange
  // callback; getRangeAt also tracks old selection ranges retained by callers.
  for (const ref of selections) {
    const selection = ref.deref();
    if (!selection) { selections.delete(ref); continue; }
    if (selection.rangeCount) track(getRangeAt.call(selection, 0));
  }
  const points = new Set();
  for (const ref of ranges) {
    const range = ref.deref();
    if (!range) { ranges.delete(ref); continue; }
    // Do not use public offsets/setters: their lazy clamping and range collapse
    // would lose the original boundary before its node has been relocated.
    points.add(range[S.start]); points.add(range[S.end]);
  }
  return points;
}

// Atomic moves run the DOM range steps without disconnecting the subtree.
// Reuse the weak registry, including selection ranges, without invoking public
// setters (which would collapse the range between its two boundary updates).
export function preRemoveRangeBoundaries(node) {
  const points = liveBoundaries(), parent = node[S.parentNode];
  const index = parent[S.nodeArray].indexOf(node);
  for (const point of points) {
    let descendant = false;
    for (let current = point.node; current; current = current[S.parentNode]) {
      if (current === node) { descendant = true; break; }
    }
    if (descendant) { point.node = parent; point.offset = index; }
    else if (point.node === parent && point.offset > index) point.offset--;
  }
  return points;
}

export function insertRangeBoundaries(points, parent, index) {
  for (const point of points) if (point.node === parent && point.offset > index) point.offset++;
}

const setText = Object.getOwnPropertyDescriptor(Text.prototype, 'data').set;
const exclusiveText = node => node?.[S.nodeType] === 3;

// DOM's normalize algorithm merges only exclusive Text descendants. CDATA,
// comments, processing instructions, shadow trees and template contents stay
// separate. Use an explicit traversal stack so deep trees do not recurse.
Node.prototype.normalize = function() {
  if (!(this instanceof Node)) throw new TypeError('Illegal invocation');
  const root = this[S.proxy] ?? this, points = liveBoundaries();
  const stack = [{parent: root, index: 0}];
  const removeText = (parent, node) => {
    const index = parent[S.nodeArray].indexOf(node);
    if (index < 0) return;
    for (const point of points) {
      if (point.node === node) { point.node = parent; point.offset = index; }
      else if (point.node === parent && point.offset > index) point.offset--;
    }
    // Preserve current iterator, slot, style, textarea and observer hooks.
    parent[S.removeChild](node);
  };
  while (stack.length) {
    const frame = stack[stack.length - 1], children = frame.parent[S.nodeArray];
    const node = children[frame.index];
    if (!node) { stack.pop(); continue; }
    if (!exclusiveText(node)) {
      frame.index++;
      if (node[S.nodeArray].length) stack.push({parent: node, index: 0});
      continue;
    }
    let length = node[S.data].length;
    if (!length) { removeText(frame.parent, node); continue; }
    const following = [], data = [node[S.data]];
    for (let i = frame.index + 1; exclusiveText(children[i]); i++) {
      following.push(children[i]); data.push(children[i][S.data]);
    }
    // One replace-data operation, even for a singleton/non-changing Text.
    // Keep the native text setter's stylesheet/textarea invalidation hooks.
    setText.call(node, data.join(''));
    for (let i = 0; i < following.length; i++) {
      const sibling = following[i], index = frame.index + i + 1;
      for (const point of points) {
        if (point.node === sibling) { point.node = node; point.offset += length; }
        else if (point.node === frame.parent && point.offset === index) {
          point.node = node; point.offset = length;
        }
      }
      length += sibling[S.data].length;
    }
    for (const sibling of following) removeText(frame.parent, sibling);
    frame.index++;
  }
};

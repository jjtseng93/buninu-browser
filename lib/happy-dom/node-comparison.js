// DOM tree comparisons use ordinary parents: shadow roots and detached Attrs
// are separate trees, even though they retain a host or ownerDocument.
const disconnectedOrder = new WeakMap();
let nextOrder = 0;
function identity(node) {
  let order = disconnectedOrder.get(node);
  if (order === undefined) disconnectedOrder.set(node, order = ++nextOrder);
  return order;
}

export function containsNode(reference, other) {
  for (let node = other; node; node = node.parentNode) if (node === reference) return true;
  return false;
}

function ancestors(node) {
  const path = [];
  for (; node; node = node.parentNode) path.push(node);
  return path;
}

/** DOM compareDocumentPosition, including attributes' special ordering.
 * https://dom.spec.whatwg.org/#dom-node-comparedocumentposition */
export function compareNodePosition(reference, other) {
  if (reference === other) return 0;
  const referenceAttr = reference.nodeType === 2 ? reference : null;
  const otherAttr = other.nodeType === 2 ? other : null;
  const referenceNode = referenceAttr ? referenceAttr.ownerElement : reference;
  const otherNode = otherAttr ? otherAttr.ownerElement : other;

  if (referenceAttr && otherAttr && referenceNode && referenceNode === otherNode) {
    for (const attribute of referenceNode.attributes) {
      if (attribute === referenceAttr) return 32 | 4;
      if (attribute === otherAttr) return 32 | 2;
    }
  }

  const referencePath = ancestors(referenceNode), otherPath = ancestors(otherNode);
  if (!referenceNode || !otherNode || referencePath.at(-1) !== otherPath.at(-1)) {
    // A weak identity order is stable and antisymmetric without keeping any
    // document alive. Order whole disconnected trees together, and detached
    // attributes by their own identity.
    return 1 | 32 | (identity(referencePath.at(-1) ?? reference) < identity(otherPath.at(-1) ?? other) ? 4 : 2);
  }
  if (referenceNode === otherNode) return referenceAttr ? 8 | 2 : 16 | 4;
  if (referencePath.includes(otherNode)) return otherAttr ? 2 : 8 | 2;
  if (otherPath.includes(referenceNode)) return referenceAttr ? 4 : 16 | 4;

  // Find the siblings below the common ancestor. No traversal into their
  // subtrees is needed, avoiding recursion and work proportional to descendants.
  let referenceIndex = referencePath.length - 1, otherIndex = otherPath.length - 1;
  while (referencePath[referenceIndex] === otherPath[otherIndex]) {
    referenceIndex--;
    otherIndex--;
  }
  const referenceBranch = referencePath[referenceIndex], otherBranch = otherPath[otherIndex];
  // Happy DOM's sibling getters search the child array for each access; scan
  // the common parent's list once so a wide tree remains linear.
  for (const node of referencePath[referenceIndex + 1].childNodes) {
    if (node === otherBranch) return 2;
    if (node === referenceBranch) return 4;
  }
  return 4;
}

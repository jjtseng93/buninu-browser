/** DOM replace: validate first, detach the incoming node, remove the outgoing
 * node, then insert. Happy DOM's insert-then-remove order skips replacements
 * in live NodeIterators. Keep this on the renderer bindings' mutation path.
 * https://dom.spec.whatwg.org/#concept-node-replace */
function validate(parent, node, child) {
  const fail = (name) => { throw new DOMException('Invalid node replacement', name); };
  if (![1,9,11].includes(parent.nodeType)) fail('HierarchyRequestError');
  for (let ancestor = parent; ancestor; ancestor = ancestor.parentNode ?? ancestor.host) {
    if (ancestor === node) fail('HierarchyRequestError');
  }
  if (child.parentNode !== parent) fail('NotFoundError');
  if (![1,3,4,7,8,10,11].includes(node.nodeType)) fail('HierarchyRequestError');
  if (node.nodeType === 10 && parent.nodeType !== 9) fail('HierarchyRequestError');
  if (parent.nodeType !== 9) return;
  // Validate the final document, allowing the outgoing child and an incoming
  // sibling to be replaced/moved without counting either twice.
  const added = node.nodeType === 11 ? [...node.childNodes] : [node];
  const final = [];
  for (const current of parent.childNodes) {
    if (current === child) final.push(...added);
    else if (current !== node) final.push(current);
  }
  let element = false, doctype = false;
  for (const current of final) {
    if (current.nodeType === 3 || current.nodeType === 4) fail('HierarchyRequestError');
    if (current.nodeType === 1) {
      if (element) fail('HierarchyRequestError');
      element = true;
    } else if (current.nodeType === 10) {
      if (doctype || element) fail('HierarchyRequestError');
      doctype = true;
    }
  }
}

export function replaceNode(parent, node, child) {
  validate(parent, node, child);
  let reference = child.nextSibling;
  if (reference === node) reference = node.nextSibling;
  if (node.parentNode) node.parentNode.removeChild(node);
  if (child.parentNode) child.parentNode.removeChild(child);
  parent.insertBefore(node, reference);
  return child;
}

export function replaceWithNodes(child, nodes) {
  const parent = child.parentNode;
  if (!parent) return;
  let reference = child.nextSibling;
  while (reference && nodes.includes(reference)) reference = reference.nextSibling;
  // DOM's convert-nodes algorithm moves multiple arguments into a fragment
  // first, including the receiver if it occurs among the arguments.
  let node = nodes[0];
  if (nodes.length !== 1) {
    node = child.ownerDocument.createDocumentFragment();
    for (const item of nodes) node.appendChild(item);
  }
  if (child.parentNode === parent) replaceNode(parent, node, child);
  else parent.insertBefore(node, reference);
}

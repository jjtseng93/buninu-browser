// Runs unchanged in the renderer and Chromium; keep this function standalone.
export function nodeIteratorCases() {
  const results = [];
  const label = n => n ? n.id || n.nodeName : null;
  for (const tag of ['div', 'form', 'select'])
    for (const operation of ['remove', 'replace', 'replaceWith', 'self', 'sibling', 'fragment', 'descendant', 'multiple'])
      for (const position of [0, 1, 2, 3]) for (const before of [false, true]) {
        const root = document.createElement(tag);root.id = 'root';
        for (const id of ['a', 'b']) {
          const node = document.createElement('option');node.id = id;root.append(node);
        }
        const nested = document.createElement('span');nested.id = 'nested';root.firstChild.append(nested);
        const it = document.createNodeIterator(root, 1);
        for (let i = 0; i <= position; i++) it.nextNode();
        if (before) it.previousNode();
        const old = root.firstChild, x = document.createElement('em');x.id = 'x';
        if (operation === 'remove') old.remove();
        if (operation === 'replace') root.replaceChild(x, old);
        if (operation === 'replaceWith') old.replaceWith(x);
        if (operation === 'self') root.replaceChild(old, old);
        if (operation === 'sibling') root.replaceChild(root.lastChild, old);
        if (operation === 'descendant') root.replaceChild(nested, old);
        if (operation === 'fragment') {
          const fragment = document.createDocumentFragment();fragment.append(x);
          const y = document.createElement('em');y.id = 'y';fragment.append(y);
          root.replaceChild(fragment, old);
        }
        if (operation === 'multiple') old.replaceWith(x, old, root.lastChild);
        results.push([tag, operation, position, before, label(it.referenceNode),
          it.pointerBeforeReferenceNode, label(it.nextNode()), label(it.previousNode()),
          [...root.childNodes].map(label).join(',')]);
      }
  for (const whatToShow of [0, 1, -1, 4294967297, NaN, Infinity, '1', null, 1n, Object(1n), Symbol('x')]) {
    try { results.push(['mask', String(whatToShow), document.createNodeIterator(document.body, whatToShow).whatToShow]); }
    catch (e) { results.push(['mask', String(whatToShow), e.name]); }
  }
  for (const verdict of [1, 65537, -65535, NaN, Infinity, '1', null, 1n, Object(1n), Symbol('x')]) {
    try { results.push(['filter', String(verdict), !!document.createNodeIterator(document.body, 1, () => verdict).nextNode()]); }
    catch (e) { results.push(['filter', String(verdict), e.name]); }
  }
  // Filtering and root types: rejection must not prune descendants.
  for (const rootKind of ['element', 'fragment', 'text', 'comment', 'doctype'])
    for (const mask of [0, 1, 4, 128, 0xffffffff]) for (const mode of ['accept', 'reject', 'skip', 'alternating']) {
      const root = rootKind === 'fragment' ? document.createDocumentFragment()
        : rootKind === 'text' ? document.createTextNode('text')
        : rootKind === 'comment' ? document.createComment('comment')
        : rootKind === 'doctype' ? document.implementation.createDocumentType('html', '', '') : document.createElement('div');
      if (rootKind === 'element' || rootKind === 'fragment') {
        const child = document.createElement('b');child.append('text');root.append(child, document.createComment('comment'));
      }
      const it = document.createNodeIterator(root, mask, n => mode === 'accept' ? 1
        : mode === 'reject' ? 2 : mode === 'skip' ? 3 : n.nodeType === 1 ? 2 : 1);
      const forward = [], backward = [];
      for (let n; (n = it.nextNode());) forward.push(n.nodeType);
      for (let n; (n = it.previousNode());) backward.push(n.nodeType);
      results.push(['walk', rootKind, mask, mode, forward.join(','), backward.join(',')]);
    }
  return results;
}

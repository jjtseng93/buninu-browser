const previousTargets = new WeakMap();

/** Deliver pointer/mouse boundary events before movement, as a real pointer does. */
export function dispatchPointerMove(window, realm, target, x, y) {
  const document = window.document;
  const previous = previousTargets.get(document) ?? null;
  previousTargets.set(document, target);
  const ancestors = node => { const list = []; for (; node?.nodeType === 1; node = node.parentElement) list.push(node); return list; };
  const before = ancestors(previous), after = ancestors(target);
  const send = (node, type, relatedTarget, bubbles = true) => {
    if (!node) return;
    const pointer = type.startsWith('pointer');
    const Constructor = pointer ? window.PointerEvent : window.MouseEvent;
    const event = new Constructor(type, { clientX: x, clientY: y, relatedTarget, bubbles,
      composed: bubbles, cancelable: bubbles, button: pointer ? -1 : 0, buttons: 0,
      pointerId: 1, pointerType: 'mouse', isPrimary: true });
    if (realm) realm.dispatch(node, event); else node.dispatchEvent(event);
  };
  if (previous !== target) {
    for (const prefix of ['pointer', 'mouse']) {
      send(previous, `${prefix}out`, target);
      for (const node of before) if (!after.includes(node)) send(node, `${prefix}leave`, target, false);
      send(target, `${prefix}over`, previous);
      for (const node of after.toReversed()) if (!before.includes(node)) send(node, `${prefix}enter`, previous, false);
    }
  }
  send(target, 'pointermove', null);
  send(target, 'mousemove', null);
}

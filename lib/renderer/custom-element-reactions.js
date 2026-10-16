/** Bridge attribute reactions from the host DOM into the page's realm.
 * Capture the callback and observed names at registration, as browsers do.
 */
export function installAttributeReactions(Adapter, constructor, realm, callPage) {
  const callback = constructor.prototype.attributeChangedCallback;
  if (typeof callback !== "function") return;
  const observed = constructor.observedAttributes;
  const pending = new WeakMap();
  Object.defineProperty(Adapter, "observedAttributes", {
    value: observed === undefined ? [] : Array.from(observed, String),
  });
  Object.defineProperty(Adapter.prototype, "attributeChangedCallback", {
    value(name, oldValue, newValue, namespace = null) {
      const args = [name, oldValue, newValue, namespace];
      const reactions = pending.get(this);
      if (reactions) reactions.push(args);
      else callPage(callback, realm.wrap(this), args);
    },
    configurable: true,
    writable: true,
  });
  const observedNames = new Set(Adapter.observedAttributes);
  // The host DOM upgrades existing elements in place, but does not enqueue
  // their initial attribute callbacks. Capture values before construction:
  // those reactions run after the constructor and before connectedCallback.
  return (element) => {
    const reactions = Array.from(element.attributes)
      .filter(attribute => observedNames.has(attribute.localName))
      .map(attribute => [attribute.localName, null, attribute.value, attribute.namespaceURI]);
    pending.set(element, reactions);
    return {
      finish() {
        try {
          // Attribute writes by the constructor or earlier callbacks append
          // to this element's queue, after the captured initial reactions.
          for (let index = 0; index < reactions.length; index++) callPage(callback, realm.wrap(element), reactions[index]);
        } finally { pending.delete(element); }
      },
      cancel() { pending.delete(element); },
    };
  };
}

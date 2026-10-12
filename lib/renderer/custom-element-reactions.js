/** Bridge attribute reactions from the host DOM into the page's realm.
 * Capture the callback and observed names at registration, as browsers do.
 */
export function installAttributeReactions(Adapter, constructor, realm, callPage) {
  const callback = constructor.prototype.attributeChangedCallback;
  if (typeof callback !== "function") return;
  const observed = constructor.observedAttributes;
  Object.defineProperty(Adapter, "observedAttributes", {
    value: observed === undefined ? [] : Array.from(observed, String),
  });
  Object.defineProperty(Adapter.prototype, "attributeChangedCallback", {
    value(name, oldValue, newValue, namespace = null) {
      callPage(callback, realm.wrap(this), [name, oldValue, newValue, namespace]);
    },
    configurable: true,
    writable: true,
  });
}

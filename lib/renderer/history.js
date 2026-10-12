// Methods borrowed from another window's History.prototype must operate on
// their receiver, not the window in which the function was created.
const histories = new WeakMap();

export function historyBinding(location, setHref) {
  const state = { location, setHref, value: null, length: 1 };
  const receiver = (object) => {
    const record = histories.get(object);
    if (!record) throw new TypeError("Illegal invocation");
    return record;
  };
  const change = (object, data, url, push) => {
    const record = receiver(object);
    if (url !== undefined && url !== null) {
      const target = new URL(String(url), record.location.href);
      if (target.origin !== new URL(record.location.href).origin) {
        throw new DOMException("History state URL must have the document's origin.", "SecurityError");
      }
      record.setHref(target.href);
    }
    record.value = data ?? null;
    if (push) record.length++;
  };
  function History() { throw new TypeError("Illegal constructor"); }
  History.prototype = {
    constructor: History,
    get length() { return receiver(this).length; },
    get state() { return receiver(this).value; },
    scrollRestoration: "auto",
    back() {},
    forward() {},
    go() {},
    pushState(data, _title, url = undefined) { change(this, data, url, true); },
    replaceState(data, _title, url = undefined) { change(this, data, url, false); },
  };
  const history = Object.create(History.prototype);
  histories.set(history, state);
  return { History, history, pushEntry(replace) {
    state.value = null;
    if (!replace) state.length++;
  } };
}

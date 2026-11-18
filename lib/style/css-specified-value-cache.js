// Specified-value grammar is independent of the element, fonts and viewport.
// Reuse only primitive results; computed lengths/colors and mutable token trees
// must still be resolved by their callers. Bound both entry count and text so
// continuously changing inline styles cannot retain an unbounded history.
const MAX_ENTRIES = 512;
const MAX_INPUT = 512;
const MAX_RESULT = 1024;

export function cacheSpecifiedValue(normalize) {
  const pending = new Map(), resolved = new Map();
  const history = [];
  let next = 0;
  return function (name, input, allowPending = true) {
    // Preserve conversion side effects for objects/String objects. The
    // property dispatch stays outside this wrapper so unrelated properties
    // never allocate cache keys or retain their values here.
    if (typeof name !== 'string' || name.length > 128 || typeof input !== 'string' || input.length > MAX_INPUT)
      return normalize(name, input, allowPending);
    const properties = allowPending ? pending : resolved;
    const cached = properties.get(name)?.get(input);
    if (cached !== undefined) return cached;
    const result = normalize(name, input, allowPending);
    if (result === null || typeof result === 'string' && result.length <= MAX_RESULT) {
      // Keep FIFO eviction across both modes and all properties. A hit uses
      // the original strings directly, without constructing a composite key.
      const oldest = history[next];
      if (oldest) {
        oldest.values.delete(oldest.input);
        if (!oldest.values.size) oldest.properties.delete(oldest.name);
      }
      let values = properties.get(name);
      if (!values) {
        values = new Map();
        properties.set(name, values);
      }
      values.set(input, result);
      history[next] = {properties, name, values, input};
      next = (next + 1) % MAX_ENTRIES;
    }
    return result;
  };
}

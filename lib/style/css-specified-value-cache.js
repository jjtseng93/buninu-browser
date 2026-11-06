// Specified-value grammar is independent of the element, fonts and viewport.
// Reuse only primitive results; computed lengths/colors and mutable token trees
// must still be resolved by their callers. Bound both entry count and text so
// continuously changing inline styles cannot retain an unbounded history.
const MAX_ENTRIES = 512;
const MAX_INPUT = 512;
const MAX_RESULT = 1024;

export function cacheSpecifiedValue(normalize) {
  const cache = new Map();
  return function (name, input, allowPending = true) {
    // Preserve conversion side effects for objects/String objects. The
    // property dispatch stays outside this wrapper so unrelated properties
    // never allocate cache keys or retain their values here.
    if (typeof name !== 'string' || name.length > 128 || typeof input !== 'string' || input.length > MAX_INPUT)
      return normalize(name, input, allowPending);
    const key = `${name.length}:${name}${allowPending ? '1' : '0'}${input}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = normalize(name, input, allowPending);
    if (result === null || typeof result === 'string' && result.length <= MAX_RESULT) {
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, result);
    }
    return result;
  };
}

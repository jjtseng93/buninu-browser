/**
 * Retains one encoded frame, including an encode still in progress. Multiple
 * CDP clients asking for the same frame share that work. Older encodes may
 * finish after a newer one, but must not replace its cache entry.
 */
export class FrameCaptureCache {
  #entry = null;

  get(key, capture) {
    if (this.#entry?.key === key) return this.#entry.promise;
    const entry = { key, promise: null };
    this.#entry = entry;
    try {
      entry.promise = Promise.resolve(capture());
    } catch (error) {
      entry.promise = Promise.reject(error);
    }
    entry.promise = entry.promise.catch((error) => {
      // A transient encoder failure must not poison subsequent captures.
      if (this.#entry === entry) this.#entry = null;
      throw error;
    });
    return entry.promise;
  }
}

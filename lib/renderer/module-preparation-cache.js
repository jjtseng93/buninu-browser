const NativeTextDecoder = TextDecoder;

/**
 * One document's speculative module preparation. Only executable root scripts
 * enter this cache; modulepreload links still fetch bytes without parsing them.
 * Entries contain strings/promises, never a realm, compiled function or imports.
 */
export class ModulePreparationCache {
  #entries = new Map();
  #bytes = 0;
  #disposed = false;
  #rewriteScript;
  #mode;
  #isCurrent;
  #maxEntries;
  #maxBytes;
  #maxSourceBytes;

  constructor(rewriteScript, {
    mode, isCurrent = () => true, maxEntries = 32,
    maxBytes = 8 * 1024 * 1024, maxSourceBytes = 2 * 1024 * 1024,
  }) {
    this.#rewriteScript = rewriteScript;
    this.#mode = mode;
    this.#isCurrent = isCurrent;
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
    this.#maxSourceBytes = maxSourceBytes;
  }

  get size() { return this.#entries.size; }
  get bytes() { return this.#bytes; }

  #active() {
    if (!this.#disposed && !this.#isCurrent()) this.dispose();
    return !this.#disposed;
  }

  /** A failed/oversized fetch keeps its ordinary fetchScript behavior. */
  preloadResponse(response) {
    if (!this.#active() || !response?.ok || !response.body
      || response.body.byteLength > this.#maxSourceBytes) return false;
    return this.preload(new NativeTextDecoder().decode(response.body));
  }

  preload(source) {
    if (!this.#active() || !this.#rewriteScript || typeof source !== "string") return false;
    if (this.#entries.has(source)) return true;
    // Conservative UTF-16 accounting; completed results add their code and
    // request strings below. Oversized transient work is never retained here.
    const bytes = source.length * 2 + 256;
    if (source.length * 2 > this.#maxSourceBytes || this.#entries.size >= this.#maxEntries
      || this.#bytes + bytes > this.#maxBytes) {
      return false;
    }
    const entry = { bytes, promise: null };
    this.#entries.set(source, entry);
    this.#bytes += bytes;
    try {
      entry.promise = Promise.resolve(this.#rewriteScript(source, { type: "module", mode: this.#mode })).then(result => {
        if (this.#active() && this.#entries.get(source) === entry) {
          const resultBytes = typeof result?.code === "string" && Array.isArray(result.requests)
            ? result.code.length * 2 + result.requests.reduce((sum, request) =>
              sum + 128 + String(request?.specifier ?? "").length * 2 + String(request?.type ?? "").length * 2, 0)
            : this.#maxBytes + 1;
          if (this.#bytes + resultBytes > this.#maxBytes) this.#remove(source, entry);
          else { entry.bytes += resultBytes; this.#bytes += resultBytes; }
        }
        return result;
      }, error => {
        this.#remove(source, entry);
        throw error;
      });
      // Failure is reported/retried when the module is actually requested.
      entry.promise.catch(() => {});
      return true;
    } catch {
      this.#remove(source, entry);
      return false;
    }
  }

  /** Consume by exact source and realm mode, then release our retained copy. */
  consume(source, mode) {
    if (!this.#active() || mode !== this.#mode) return null;
    const entry = this.#entries.get(source);
    if (!entry) return null;
    this.#remove(source, entry);
    return entry.promise;
  }

  #remove(source, entry) {
    if (this.#entries.get(source) !== entry) return;
    this.#entries.delete(source);
    this.#bytes -= entry.bytes;
  }

  dispose() {
    this.#disposed = true;
    this.#entries.clear();
    this.#bytes = 0;
  }
}

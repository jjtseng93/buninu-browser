import { escapeSesHtmlComments, rewriteClassicScriptSource } from "./script-rewrite.js";

/**
 * Reuse deterministic source preparation across documents and repeated evals.
 * Only strings/parse flags are retained, never a document, AST, or executable
 * closure. Evaluation still happens in the current page's SES compartment.
 */
export class PreparedScriptCache {
  #entries = new Map();
  #bytes = 0;
  #maxBytes;
  #maxEntries;
  #prepare;

  constructor({ maxBytes = 4 * 1024 * 1024, maxEntries = 128, prepare = prepareSource } = {}) {
    this.#maxBytes = Math.max(0, maxBytes);
    this.#maxEntries = Math.max(0, maxEntries);
    this.#prepare = prepare;
  }

  prepare(source) {
    const cached = this.#entries.get(source);
    if (cached) {
      this.#entries.delete(source);
      this.#entries.set(source, cached);
      return cached.result;
    }
    const result = Object.freeze(this.#prepare(source));
    // Conservative UTF-16 accounting, including both the key and rewritten
    // source, even when the engine can share their underlying string storage.
    const bytes = (source.length + result.code.length) * 2;
    if (!this.#maxEntries || bytes > this.#maxBytes) return result;
    while (this.#entries.size && (this.#entries.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes)) {
      const key = this.#entries.keys().next().value;
      this.#bytes -= this.#entries.get(key).bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(source, { result, bytes });
    this.#bytes += bytes;
    return result;
  }
}

function prepareSource(source) {
  const classic = rewriteClassicScriptSource(source);
  return { code: escapeSesHtmlComments(classic.code), parsed: classic.parsed, strict: classic.strict };
}

const mainThreadCache = new PreparedScriptCache();
export const prepareClassicScript = source => mainThreadCache.prepare(source);

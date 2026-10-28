import { CookieJar } from "../network/cookie-jar.js";

/** Shared by the document and its same-origin frames; the controller remains authoritative. */
export class DocumentCookies {
  #jar;
  #now;
  #send;
  #nextSequence = 1;
  #revision = -1;
  #acknowledged = 0;
  #pending = new Map();
  #legacyCookie = "";

  constructor(send = () => {}, now = () => Date.now()) {
    this.#send = send;
    this.#now = now;
    this.#jar = new CookieJar({ now });
  }

  get(url) {
    return this.#revision < 0 ? this.#legacyCookie : this.#jar.documentCookie(url);
  }

  set(url, value) {
    const assignment = String(value);
    // The controller imposes the same IPC limit; rejected writes cannot
    // temporarily create a cookie which the controller will never accept.
    if (assignment.length > 4096) return;
    const sequence = this.#nextSequence++;
    // Legacy embedders need not acknowledge setters. Only retain mutations
    // after the controller has established the versioned snapshot protocol.
    if (this.#revision < 0) {
      this.#legacyCookie = mergeLegacyCookie(this.#legacyCookie, assignment, this.#now());
    } else {
      const mutation = { sequence, url, value: assignment, receivedAt: this.#now() };
      this.#pending.set(sequence, mutation);
      this.#jar.store(url, [assignment], { fromScript: true, receivedAt: mutation.receivedAt });
    }
    this.#send(assignment, url, sequence);
  }

  accept(state) {
    if (!state || !Number.isSafeInteger(state.revision) || state.revision <= this.#revision
        || !Number.isSafeInteger(state.acknowledged) || state.acknowledged < this.#acknowledged
        || !Array.isArray(state.cookies)) return false;
    this.#revision = state.revision;
    this.#acknowledged = state.acknowledged;
    this.#legacyCookie = "";
    for (const sequence of this.#pending.keys()) {
      if (sequence <= state.acknowledged) this.#pending.delete(sequence);
    }
    this.#jar.replaceScriptSnapshot(state.cookies);
    // A response may have been queued before a newer synchronous setter ran.
    // Replay only those setters, retaining unrelated server cookies and the
    // original Max-Age start time rather than extending it on each snapshot.
    for (const mutation of this.#pending.values()) {
      this.#jar.store(mutation.url, [mutation.value], { fromScript: true, receivedAt: mutation.receivedAt });
    }
    return true;
  }

  /** Compatibility for embedders providing only the old documentCookie string. */
  seed(url, value, replace = false) {
    if (this.#revision >= 0 || typeof value !== "string") return;
    // A header has no Path/Domain metadata, so preserve it verbatim instead of
    // inventing records (which would collapse legitimate duplicate names).
    // An embedded about:blank initial load must not erase its parent's value.
    if (replace || value) this.#legacyCookie = value;
  }
}

/** Preserve the string-only embedder API until a controller snapshot arrives. */
function mergeLegacyCookie(current, assignment, now) {
  const [pair, ...attributes] = assignment.split(";");
  const equals = pair.indexOf("=");
  if (equals < 1) return current;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  const expired = attributes.some(attribute => {
    const [key, argument = ""] = attribute.split("=").map(part => part.trim().toLowerCase());
    return (key === "max-age" && Number(argument) <= 0)
      || (key === "expires" && Date.parse(argument) <= now);
  });
  const entries = current ? current.split("; ").filter(entry => !entry.startsWith(`${name}=`)) : [];
  if (!expired) entries.push(`${name}=${value}`);
  return entries.join("; ");
}

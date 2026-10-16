/**
 * The controller's network service: every request a page causes goes through
 * here, so cookies, CORS and redirects are decided in the trusted process.
 *
 * - Documents: top-level navigations (cookies with SameSite=Lax allowed).
 * - Subresources: stylesheets, images and classic scripts (no-cors mode).
 * - Page fetches: fetch()/XMLHttpRequest from page scripts, under the Fetch
 *   standard's CORS protocol, including preflight requests.
 *
 * The requesting document's URL is always the controller's own record, never
 * something the renderer claims.
 */
import { CookieJar, siteOf } from "./cookie-jar.js";
import { fetchResolved, HostResolver } from "./resolver.js";

const MAX_REDIRECTS = 20;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_SUBRESOURCES = 256;
const MAX_CACHED_SUBRESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_PREFLIGHTS = 256;
const MAX_PREFLIGHT_AGE = 7200;
const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
// Fetch §2.2.2 CORS-safelisted request headers.
const SAFELISTED_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-language", "content-type", "range"]);
const SIMPLE_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
// Headers a page may not set (Fetch §2.2.2 forbidden request headers).
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive",
  "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
]);
const SAFELISTED_RESPONSE_HEADERS = new Set([
  "cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma",
]);
// Requests in flight to one host at a time, as browsers allow over HTTP/1.1.
const MAX_REQUESTS_PER_HOST = 6;
// Which waiting request to a busy host goes next (lower first): documents,
// then what blocks rendering or that a script waits for, then the rest.
const PRIORITY = { document: 0, iframe: 1, stylesheet: 1, fetch: 1, script: 2, metadata: 2, image: 3, video: 3, audio: 3 };

export class NetworkService {
  #fetch;
  #resolver;
  #cookies;
  #userAgent;
  // Browser-process HTTP cache. Entries are partitioned by the request
  // credentials that affect a subresource response; concurrent identical
  // requests share one transfer.
  #subresourceCache = new Map();
  #subresourceCacheBytes = 0;
  #maxSubresourceCacheBytes;
  #subresourceInflight = new Map();
  #preflightCache = new Map();
  #hosts = new HostThrottle(MAX_REQUESTS_PER_HOST);

  /**
   * `resolver` looks host names up itself (see resolver.js); it is on for the
   * real network and off when a test supplies its own `fetch`.
   */
  constructor({
    fetch: fetchImpl = fetch, cookies = new CookieJar(), userAgent = null,
    resolver = fetchImpl === globalThis.fetch ? new HostResolver() : null,
    maxSubresourceCacheBytes = MAX_CACHED_SUBRESOURCE_BYTES,
  } = {}) {
    this.#maxSubresourceCacheBytes = Math.max(0, maxSubresourceCacheBytes);
    this.#fetch = fetchImpl;
    this.#resolver = resolver;
    this.#cookies = cookies;
    this.#userAgent = userAgent;
  }

  get cookies() {
    return this.#cookies;
  }

  set userAgent(value) {
    const next = typeof value === "string" && value ? value : null;
    if (next !== this.#userAgent) { this.#subresourceCache.clear(); this.#subresourceCacheBytes = 0; }
    this.#userAgent = next;
  }

  /** A top-level document load. */
  /**
   * Fetches a document to navigate to. A form POST (`post`) sends its body,
   * with Origin and a Referer trimmed to the origin across origins
   * (strict-origin-when-cross-origin); a redirect after it turns into a GET.
   */
  async navigate(url, { onResponse, post = null, referrer = post?.referrer ?? null } = {}) {
    const headers = [];
    let method = "GET";
    let body = null;
    if (post) {
      method = "POST";
      body = post.body;
      headers.push(["content-type", post.contentType]);
      let from = null;
      try { from = new URL(referrer); } catch {}
      if (from && ["http:", "https:"].includes(from.protocol)) {
        headers.push(["origin", from.origin]);
      }
    }
    return this.#send({ url, method, headers, body }, {
      credentials: "include", site: referrer ? siteOf(referrer) : null, topLevelNavigation: true,
      referrer, fetchMode: "navigate", fetchDest: "document", directNavigation: !referrer,
    }, { onResponse, priority: PRIORITY.document });
  }

  /**
   * A subresource the renderer needs to render (no-cors, credentials included).
   * `kind` ("stylesheet", "script", "image"...) decides its turn at a busy host.
   */
  async subresource(url, documentUrl, kind = "metadata", { signal } = {}) {
    signal?.throwIfAborted();
    const site = siteOf(documentUrl);
    const cookie = this.#cookies.header(url, { site });
    const metadata = subresourceMetadata(kind);
    const key = JSON.stringify([url, new URL(documentUrl).origin, cookie, this.#userAgent, metadata.fetchMode, metadata.fetchDest]);
    const entry = this.#subresourceCache.get(key);
    const cached = entry && (!entry.varyReferer || entry.referrer === documentUrl) ? entry : null;
    if (cached && cached.expires > Date.now()) {
      this.#subresourceCache.delete(key); this.#subresourceCache.set(key, cached);
      return cached.result;
    }
    // Concurrent transfers must have identical referrers, even before the
    // response tells us whether its representation varies with that header.
    const inflightKey = JSON.stringify([key, documentUrl]);
    const pending = this.#subresourceInflight.get(inflightKey);
    if (pending && !pending.controller.signal.aborted) return shareResource(pending, signal);
    const transfer = { controller: new AbortController(), users: 0, done: false, promise: null };
    const request = (async () => {
      const headers = cached?.etag ? [["if-none-match", cached.etag]]
        : cached?.lastModified ? [["if-modified-since", cached.lastModified]] : [];
      let result = await this.#send({ url, method: "GET", headers, body: null }, {
        credentials: "include", site, referrer: documentUrl, ...metadata,
      }, { priority: PRIORITY[kind] ?? PRIORITY.metadata, signal: transfer.controller.signal });
      if (result.status === 304 && cached) {
        const rawHeaders = [...new Map([...cached.result.rawHeaders, ...result.rawHeaders])];
        result = {
          ...cached.result,
          rawHeaders,
          headers: [...new Map([...cached.result.headers, ...result.headers])],
        };
      }
      const policy = cachePolicy(result.rawHeaders);
      this.#forgetSubresource(key);
      const bytes = result.body.byteLength;
      // A final response cannot establish freshness for redirects that led
      // to it. Their policies and cookies may differ from the initial URL.
      // Keep coalescing transfers, but cache direct responses until each
      // redirect hop has its own HTTP cache entry.
      if (result.ok && !result.redirected && policy.cacheable && bytes <= this.#maxSubresourceCacheBytes) {
        while (this.#subresourceCache.size && (this.#subresourceCache.size >= MAX_CACHED_SUBRESOURCES
            || this.#subresourceCacheBytes + bytes > this.#maxSubresourceCacheBytes)) {
          this.#forgetSubresource(this.#subresourceCache.keys().next().value);
        }
        this.#subresourceCache.set(key, { result, ...policy, bytes, referrer: documentUrl });
        this.#subresourceCacheBytes += bytes;
      }
      return result;
    })();
    transfer.promise = request;
    this.#subresourceInflight.set(inflightKey, transfer);
    const finish = () => {
      transfer.done = true;
      if (this.#subresourceInflight.get(inflightKey) === transfer) this.#subresourceInflight.delete(inflightKey);
    };
    request.then(finish, finish);
    return shareResource(transfer, signal);
  }

  #forgetSubresource(key) {
    const cached = this.#subresourceCache.get(key);
    if (cached) this.#subresourceCacheBytes -= cached.bytes;
    this.#subresourceCache.delete(key);
  }

  /**
   * A video or audio subresource whose body is delivered as it arrives.
   * `emit` is called with `{ type: "head", ... }`, then `{ type: "chunk", data }`,
   * then `{ type: "end" }` or `{ type: "error", error }`. Nothing is cached:
   * a growing body is not a reusable response. The host slot stays held until
   * the body has been read, same as a buffered subresource.
   */
  streamSubresource(url, documentUrl, kind, emit, { signal } = {}) {
    const site = siteOf(documentUrl);
    return this.#send({ url, method: "GET", headers: [], body: null }, {
      credentials: "include", site, referrer: documentUrl, ...subresourceMetadata(kind),
    }, {
      priority: PRIORITY[kind] ?? PRIORITY.metadata,
      signal,
      onResponse: async (response, finalUrl) => {
        const contentLength = Number(response.headers.get("content-length"));
        try {
          emit({
            type: "head",
            ok: response.status >= 200 && response.status <= 299,
            status: response.status,
            statusText: response.statusText ?? "",
            url: finalUrl,
            contentType: response.headers.get("content-type") ?? "",
            contentLength: Number.isFinite(contentLength) ? contentLength : null,
          });
          const reader = response.body?.getReader?.();
          if (!reader) {
            emit({ type: "end" });
            return { streamed: true };
          }
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              emit({ type: "error", error: "Response body too large" });
              await reader.cancel().catch(() => {});
              return { streamed: true };
            }
            emit({ type: "chunk", data: value });
          }
          emit({ type: "end" });
        } catch (error) {
          emit({ type: "error", error: String(error?.message ?? error) });
        }
        return { streamed: true };
      },
    });
  }

  /**
   * A WebSocket opened by page script, using Bun's WebSocket: the handshake
   * carries the document's Origin, the target's cookies (as for an https/http
   * request to the same host) and the user agent.
   * @param {string} url ws: or wss:
   * @param {string[]} protocols
   * @param {string} documentUrl
   */
  webSocket(url, protocols, documentUrl) {
    const target = new URL(url);
    if (target.protocol !== "ws:" && target.protocol !== "wss:") throw new TypeError(`blocked WebSocket scheme ${target.protocol}`);
    // Always an Origin, "null" for opaque ones (data:, about:blank), as
    // browsers send it: servers such as the CDP endpoint accept handshakes
    // without one (non-browser clients) and must see that a page is asking.
    const headers = { Origin: new URL(documentUrl).origin };
    const http = new URL(target.href.replace(/^ws/, "http"));
    const cookie = this.#cookies.header(http.href, { site: siteOf(documentUrl) });
    if (cookie) headers.Cookie = cookie;
    if (this.#userAgent) headers["User-Agent"] = this.#userAgent;
    return new WebSocket(target.href, { headers, protocols });
  }

  /** document.cookie for a document. */
  documentCookie(documentUrl) {
    return this.#cookies.documentCookie(documentUrl);
  }

  /** document.cookie = "..." from a page. */
  setDocumentCookie(documentUrl, value) {
    this.#cookies.store(documentUrl, [String(value)], { fromScript: true });
  }

  /**
   * fetch()/XMLHttpRequest from page script.
   * @param {{ url: string, method?: string, headers?: [string, string][], body?: Uint8Array | null,
   *   mode?: "cors" | "no-cors" | "same-origin", credentials?: "omit" | "same-origin" | "include",
   *   redirect?: "follow" | "error" | "manual" }} request
   * @param {string} documentUrl the requesting document (controller's record)
   */
  async pageFetch(request, documentUrl, { signal, onChunk = null } = {}) {
    const origin = new URL(documentUrl).origin;
    const url = new URL(request.url);
    const method = String(request.method ?? "GET").toUpperCase();
    const mode = request.mode ?? "cors";
    const credentials = request.credentials ?? "same-origin";
    if (!["cors", "no-cors", "same-origin"].includes(mode)) throw new TypeError(`Invalid request mode ${mode}`);
    if (!["omit", "same-origin", "include"].includes(credentials)) throw new TypeError(`Invalid credentials mode ${credentials}`);
    if (FORBIDDEN_METHODS.has(method)) throw new TypeError(`Forbidden method ${method}`);
    if (!["http:", "https:"].includes(url.protocol)) throw new TypeError(`Fetch API cannot load ${url.protocol} URLs`);
    const headers = (request.headers ?? [])
      .map(([name, value]) => [String(name).toLowerCase(), String(value)])
      .filter(([name]) => !FORBIDDEN_REQUEST_HEADERS.has(name) && !name.startsWith("proxy-") && !name.startsWith("sec-"));
    const sameOrigin = url.origin === origin;
    if (mode === "same-origin" && !sameOrigin) throw new TypeError("Request was blocked: mode is same-origin");
    if (mode === "no-cors" && !SIMPLE_METHODS.has(method)) throw new TypeError(`${method} is not allowed in no-cors mode`);

    const context = { pageRequest: true, credentials, site: siteOf(documentUrl), origin,
      referrer: documentUrl, fetchMode: mode, fetchDest: "empty" };
    return this.#send({ url: url.href, method,
      headers: mode === "no-cors" ? headers.filter(entry => entry[0] !== "range" && isSafelistedHeader(entry)) : headers,
      body: request.body ?? null }, context, {
      redirect: request.redirect ?? "follow", priority: PRIORITY.fetch, signal,
      onResponse: onChunk ? (response, finalUrl, redirected, type, visibleHeaders) =>
        this.#streamResult(response, finalUrl, redirected, type, visibleHeaders, onChunk) : null,
    });
  }

  async #preflight(url, method, headers, origin, context, signal) {
    signal?.throwIfAborted();
    const requestHeaders = [...new Set(headers.filter((entry) => !isSafelistedHeader(entry)).map(([name]) => name))].sort();
    // Cache only the checked permission tuple, never the response body. Exact
    // tuples keep credentials, origins, URLs and header-name sets isolated;
    // header values do not change the server's permission to send that name.
    // Opaque origins serialize to the same string, so do not share them here.
    const cacheKey = origin === "null" ? null
      : JSON.stringify([context.site, origin, withoutFragment(url.href), context.credentials, method, requestHeaders]);
    if (cacheKey && (this.#preflightCache.get(cacheKey) ?? 0) > Date.now()) {
      const expires = this.#preflightCache.get(cacheKey);
      this.#preflightCache.delete(cacheKey); this.#preflightCache.set(cacheKey, expires);
      return;
    }
    this.#preflightCache.delete(cacheKey);
    const release = await this.#hosts.acquire(url.href, PRIORITY.fetch, signal);
    let response;
    try {
      const preflightHeaders = new Headers({ origin, "access-control-request-method": method,
        ...(requestHeaders.length ? { "access-control-request-headers": requestHeaders.join(",") } : {}),
        ...(this.#userAgent ? { "user-agent": this.#userAgent } : {}) });
      setFetchMetadata(preflightHeaders, url.href, { fetchMode: "cors", fetchDest: "empty" },
        fetchMetadataSite(context.referrer, url.href, "same-origin"));
      response = await this.#request(url.href, {
        method: "OPTIONS",
        redirect: "manual",
        signal,
        headers: preflightHeaders,
      });
      await response.arrayBuffer().catch(() => {});
    } finally {
      release();
    }
    // A cancelled body read must not turn into a reusable permission grant.
    signal?.throwIfAborted();
    const raw = [...response.headers];
    if (response.status < 200 || response.status > 299 || !corsAllowed(raw, origin, context.credentials === "include")) {
      throw new TypeError(`CORS preflight for ${url.href} was rejected`);
    }
    const allowMethods = (header(raw, "access-control-allow-methods") ?? "").split(",").map((value) => value.trim().toUpperCase());
    const allowHeaders = (header(raw, "access-control-allow-headers") ?? "").split(",").map((value) => value.trim().toLowerCase());
    const wildcard = context.credentials !== "include";
    if (!SIMPLE_METHODS.has(method) && !allowMethods.includes(method) && !(wildcard && allowMethods.includes("*"))) {
      throw new TypeError(`CORS preflight for ${url.href} does not allow method ${method}`);
    }
    for (const name of requestHeaders) {
      // Authorization is a CORS non-wildcard request-header name.
      if (!allowHeaders.includes(name) && !(wildcard && name !== "authorization" && allowHeaders.includes("*"))) {
        throw new TypeError(`CORS preflight for ${url.href} does not allow header ${name}`);
      }
    }
    const value = header(raw, "access-control-max-age")?.trim();
    const maxAge = value !== undefined && value !== null && /^-?\d+$/.test(value)
      ? Math.max(0, Math.min(Number(value), MAX_PREFLIGHT_AGE)) : 5;
    if (cacheKey && maxAge > 0) {
      if (this.#preflightCache.size >= MAX_CACHED_PREFLIGHTS) this.#preflightCache.delete(this.#preflightCache.keys().next().value);
      this.#preflightCache.set(cacheKey, Date.now() + maxAge * 1000);
    }
  }

  #request(url, init) {
    return this.#resolver ? fetchResolved(this.#fetch, this.#resolver, url, init) : this.#fetch(url, init);
  }

  /**
   * Sends a request, following redirects by hand so cookies apply to every hop.
   * Each hop holds one of its host's request slots until its body is read.
   */
  async #send(request, context, {
    redirect = "follow", onResponse = null, priority = PRIORITY.metadata, signal = undefined,
  } = {}) {
    let { url, method, body } = request;
    const baseHeaders = new Headers(request.headers);
    let redirected = false;
    let requestReferrer = context.referrer ?? "";
    let requestOrigin = context.origin;
    let responseType = "basic";
    let metadataSite = context.directNavigation ? "none" : "same-origin";
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(url);
      const crossOrigin = context.pageRequest && (requestOrigin !== target.origin || responseType !== "basic");
      if (crossOrigin && context.fetchMode === "same-origin") throw new TypeError("Request was blocked: mode is same-origin");
      if (crossOrigin) responseType = context.fetchMode === "no-cors" ? "opaque" : "cors";
      const withCredentials = context.credentials === "include"
        || (context.pageRequest && context.credentials === "same-origin" && responseType === "basic");
      if (responseType === "cors" && (!SIMPLE_METHODS.has(method) || [...baseHeaders].some(entry => !isSafelistedHeader(entry)))) {
        await this.#preflight(target, method, [...baseHeaders], requestOrigin,
          { ...context, credentials: withCredentials ? "include" : "omit" }, signal);
      }
      const headers = new Headers(baseHeaders);
      metadataSite = fetchMetadataSite(context.referrer, url, metadataSite);
      setFetchMetadata(headers, url, context, metadataSite);
      if (this.#userAgent) {
        headers.set("user-agent", this.#userAgent);
        const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(this.#userAgent)?.[1];
        if (chrome) {
          headers.set("sec-ch-ua", `"Not:A-Brand";v="99", "Chromium";v="${chrome}", "Google Chrome";v="${chrome}"`);
          headers.set("sec-ch-ua-mobile", /\bMobile\b/.test(this.#userAgent) ? "?1" : "?0");
          headers.set("sec-ch-ua-platform", `"${/Android/.test(this.#userAgent) ? "Android" : /Windows/.test(this.#userAgent) ? "Windows" : /Macintosh/.test(this.#userAgent) ? "macOS" : "Linux"}"`);
        }
      }
      if (responseType === "cors" || (context.pageRequest && !["GET", "HEAD"].includes(method))) {
        headers.set("origin", requestOrigin);
      }
      if (!headers.has("referer")) {
        requestReferrer = defaultReferrer(requestReferrer, url);
        if (requestReferrer) headers.set("referer", requestReferrer);
      }
      if (withCredentials) {
        const cookie = this.#cookies.header(url, {
          site: context.site, topLevelNavigation: Boolean(context.topLevelNavigation), method,
        });
        if (cookie) headers.set("cookie", cookie);
      }
      const release = await this.#hosts.acquire(url, priority, signal);
      try {
        const response = await this.#request(url, { method, headers, body, redirect: "manual", signal });
        if (withCredentials) this.#cookies.store(url, response.headers.getSetCookie?.() ?? []);
        const rawHeaders = [...response.headers];
        if (responseType === "cors" && !corsAllowed(rawHeaders, requestOrigin, withCredentials)) {
          await response.body?.cancel().catch(() => {});
          throw new TypeError(`CORS: ${url} did not allow origin ${requestOrigin}`);
        }
        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          await response.arrayBuffer().catch(() => {});
          if (redirect === "error") throw new TypeError("Redirect was not allowed");
          if (redirect === "manual") return opaqueRedirect(response);
          const next = new URL(location, url);
          if (!["http:", "https:"].includes(next.protocol)) throw new TypeError(`Redirect to ${next.protocol} is not allowed`);
          if (context.pageRequest && target.origin !== next.origin) {
            baseHeaders.delete("authorization");
            if (requestOrigin !== target.origin) requestOrigin = "null";
          }
          if ((response.status === 303 && method !== "GET" && method !== "HEAD")
            || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = method === "HEAD" ? "HEAD" : "GET";
            body = null;
            for (const name of ["content-encoding", "content-language", "content-location", "content-type"]) baseHeaders.delete(name);
          }
          url = next.href;
          redirected = true;
          continue;
        }
        if (responseType === "opaque") {
          await response.body?.cancel().catch(() => {});
          return { ok: false, type: "opaque", status: 0, statusText: "", url: "", headers: [], rawHeaders,
            contentType: "", body: new Uint8Array(0), redirected: false };
        }
        const visibleHeaders = responseType === "cors" ? corsResponseHeaders(rawHeaders, withCredentials) : rawHeaders;
        if (onResponse) {
          const handled = await onResponse(response, url, redirected, responseType, visibleHeaders);
          if (handled) return handled;
        }
        const result = await this.#result(response, url, redirected, responseType);
        if (responseType === "cors") result.headers = corsResponseHeaders(result.headers, withCredentials, rawHeaders);
        return context.topLevelNavigation ? { ...result, referrer: requestReferrer } : result;
      } finally {
        release();
      }
    }
    throw new TypeError("Too many redirects");
  }

  async #result(response, url, redirected, type) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BODY_BYTES) throw new TypeError("Response body too large");
    const rawHeaders = [...response.headers];
    return {
      ok: response.status >= 200 && response.status <= 299,
      status: response.status,
      statusText: response.statusText,
      url,
      redirected,
      type,
      rawHeaders,
      // Set-Cookie never reaches pages (Fetch "forbidden response header name").
      headers: rawHeaders.filter(([name]) => name !== "set-cookie" && name !== "set-cookie2"),
      contentType: response.headers.get("content-type") ?? "",
      body: buffer,
    };
  }

  async #streamResult(response, url, redirected, type, visibleHeaders, onChunk) {
    const rawHeaders = [...response.headers];
    const result = {
      ok: response.status >= 200 && response.status <= 299,
      status: response.status, statusText: response.statusText, url, redirected, type,
      headers: visibleHeaders.filter(([name]) => name !== "set-cookie" && name !== "set-cookie2"),
      contentType: response.headers.get("content-type") ?? "",
    };
    onChunk({ type: "head", result });
    const reader = response.body?.getReader?.();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) onChunk({ type: "chunk", data: value });
      }
    }
    onChunk({ type: "end" });
    return { ...result, rawHeaders, body: new Uint8Array(0), streaming: true };
  }
}

/**
 * The opaque-redirect filtered response a `redirect: "manual"` fetch gets
 * (Fetch §2.2.6): status 0 and no headers or body for the page. The redirect's
 * body was already drained to free the connection; the raw headers stay for
 * the CORS check.
 */
function opaqueRedirect(response) {
  return {
    ok: false, status: 0, statusText: "", url: "", redirected: false, type: "opaqueredirect",
    rawHeaders: [...response.headers], headers: [], contentType: "", body: new Uint8Array(0),
  };
}

/** A URL without its fragment, as a Referer carries it. */
function withoutFragment(href) {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

function subresourceMetadata(kind) {
  return { fetchMode: kind === "iframe" ? "navigate" : "no-cors",
    fetchDest: ({ stylesheet: "style", script: "script", image: "image", video: "video", audio: "audio", iframe: "iframe" })[kind] ?? "empty" };
}

// Fetch Metadata belongs to the trusted network process. Page-supplied sec-*
// headers are filtered above. Do not claim user activation without tracking it.
function setFetchMetadata(headers, href, context, site) {
  const url = new URL(href);
  if (!trustworthyHttpUrl(url)) return;
  headers.set("sec-fetch-mode", context.fetchMode ?? "cors");
  headers.set("sec-fetch-dest", context.fetchDest ?? "empty");
  if (site) headers.set("sec-fetch-site", site);
}

function trustworthyHttpUrl(url) {
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || url.hostname === "[::1]" || /^127\./.test(url.hostname);
  return url.protocol === "https:" || (url.protocol === "http:" && local);
}

/** The default strict-origin-when-cross-origin referrer policy. */
function defaultReferrer(referrer, href) {
  if (!referrer) return "";
  const from = new URL(referrer), target = new URL(href);
  if (!["http:", "https:"].includes(from.protocol)) return "";
  if (trustworthyHttpUrl(from) && !trustworthyHttpUrl(target)) return "";
  from.username = ""; from.password = ""; from.hash = "";
  return from.origin === target.origin && from.href.length <= 4096 ? from.href : `${from.origin}/`;
}

function fetchMetadataSite(referrer, href, previous) {
  if (previous === "none" || previous === "cross-site") return previous;
  if (!referrer) return "cross-site";
  const from = new URL(referrer), target = new URL(href);
  if (from.origin === "null" || from.protocol !== target.protocol) return "cross-site";
  if (previous === null) return null;
  if (from.origin === target.origin) return previous;
  if (from.hostname === target.hostname) return "same-site";
  // Different hosts require a public-suffix list to distinguish same-site
  // from cross-site. Omit this optional header for that redirect chain until
  // we have one; guessing from the last two labels falsely trusts e.g. co.uk.
  return null;
}

function isSafelistedHeader([name, value]) {
  if (!SAFELISTED_REQUEST_HEADERS.has(name) || value.length > 128) return false;
  if (name === "accept-language" || name === "content-language") return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
  if (name === "range") {
    const range = /^bytes=(\d+)-(\d*)$/.exec(value);
    return !!range && (!range[2] || BigInt(range[1]) <= BigInt(range[2]));
  }
  // CORS-unsafe request-header bytes, excluding HT (0x09).
  if (/[\x00-\x08\x0a-\x1f\x7f"():<>?@\[\\\]{}]/.test(value)) return false;
  return name !== "content-type" || SIMPLE_CONTENT_TYPES.has(value.split(";")[0].trim().toLowerCase());
}

function header(rawHeaders, name) {
  return rawHeaders.find(([key]) => key === name)?.[1] ?? null;
}

/** Freshness and validator data used by the in-process HTTP cache. */
function cachePolicy(rawHeaders, now = Date.now()) {
  const control = (header(rawHeaders, "cache-control") ?? "").toLowerCase();
  const varies = (header(rawHeaders, "vary") ?? "").toLowerCase().split(",").map(name => name.trim());
  const variesEveryRequest = varies.includes("*");
  if (variesEveryRequest || /(?:^|,)\s*no-store(?:\s|,|$)/.test(control)) return { cacheable: false };
  const maxAge = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/)?.[1];
  const date = Date.parse(header(rawHeaders, "date") ?? "");
  const age = Math.max(0, Number(header(rawHeaders, "age")) || 0) * 1000;
  const apparentAge = Number.isFinite(date) ? Math.max(0, now - date) : 0;
  const currentAge = Math.max(age, apparentAge);
  const expiresHeader = Date.parse(header(rawHeaders, "expires") ?? "");
  let expires = maxAge !== undefined ? now + Number(maxAge) * 1000 - currentAge
    : Number.isFinite(expiresHeader) ? now + Math.max(0, expiresHeader - (Number.isFinite(date) ? date : now)) - currentAge : 0;
  if (/(?:^|,)\s*no-cache(?:\s|=|,|$)/.test(control)) expires = 0;
  const etag = header(rawHeaders, "etag");
  const lastModified = header(rawHeaders, "last-modified");
  return { cacheable: expires > now || etag !== null || lastModified !== null, expires, etag, lastModified,
    varyReferer: varies.includes("referer") };
}

/** Fetch §4.9 CORS check. */
function corsAllowed(rawHeaders, origin, withCredentials) {
  const allowOrigin = header(rawHeaders, "access-control-allow-origin");
  if (allowOrigin === null) return false;
  if (allowOrigin === "*") return !withCredentials;
  if (allowOrigin !== origin) return false;
  return !withCredentials || header(rawHeaders, "access-control-allow-credentials") === "true";
}

function corsResponseHeaders(headers, withCredentials, rawHeaders = headers) {
  const exposed = new Set((header(rawHeaders, "access-control-expose-headers") ?? "")
    .split(",").map(name => name.trim().toLowerCase()).filter(Boolean));
  const all = exposed.has("*") && !withCredentials;
  return headers.filter(([name]) => SAFELISTED_RESPONSE_HEADERS.has(name) || exposed.has(name) || all);
}

/** Cancel one document's interest without canceling other users of a transfer. */
function shareResource(transfer, signal) {
  transfer.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (--transfer.users === 0 && !transfer.done) transfer.controller.abort();
      callback(value);
    };
    const abort = () => finish(reject, signal.reason ?? new DOMException("Aborted", "AbortError"));
    transfer.promise.then(value => finish(resolve, value), error => finish(reject, error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Limits the requests in flight to each host (scheme, host and port). A burst
 * of requests that each open a connection slows every transfer, and servers
 * reset some; with a few connections kept alive and reused, a page's
 * resources arrive sooner. Waiting requests go by priority, then in order.
 */
class HostThrottle {
  #limit;
  #hosts = new Map();

  constructor(limit) {
    this.#limit = limit;
  }

  /** Resolves with a function that gives the slot back (once) when the request is done. */
  acquire(url, priority, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    let key;
    try {
      const target = new URL(url);
      key = `${target.protocol}//${target.host}`;
    } catch {
      key = String(url);
    }
    let host = this.#hosts.get(key);
    if (!host) this.#hosts.set(key, host = { active: 0, waiting: [] });
    const release = this.#releaser(key, host);
    if (host.active < this.#limit) {
      host.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const entry = { priority, start: () => {
        signal?.removeEventListener("abort", abort);
        resolve(release);
      } };
      const abort = () => {
        const index = host.waiting.indexOf(entry);
        if (index >= 0) host.waiting.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const index = host.waiting.findIndex((other) => other.priority > priority);
      if (index === -1) host.waiting.push(entry);
      else host.waiting.splice(index, 0, entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  #releaser(key, host) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = host.waiting.shift();
      if (next) next.start(); // the slot passes on
      else if (--host.active === 0) this.#hosts.delete(key);
    };
  }
}

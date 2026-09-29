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
const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
// Fetch §2.2.2 CORS-safelisted request headers (value checks simplified).
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

export class NetworkService {
  #fetch;
  #resolver;
  #cookies;
  #userAgent;

  /**
   * `resolver` looks host names up itself (see resolver.js); it is on for the
   * real network and off when a test supplies its own `fetch`.
   */
  constructor({
    fetch: fetchImpl = fetch, cookies = new CookieJar(), userAgent = null,
    resolver = fetchImpl === globalThis.fetch ? new HostResolver() : null,
  } = {}) {
    this.#fetch = fetchImpl;
    this.#resolver = resolver;
    this.#cookies = cookies;
    this.#userAgent = userAgent;
  }

  get cookies() {
    return this.#cookies;
  }

  set userAgent(value) {
    this.#userAgent = typeof value === "string" && value ? value : null;
  }

  /** A top-level document load. */
  async navigate(url) {
    return this.#send({ url, method: "GET", headers: [], body: null }, {
      credentials: "include", site: null, topLevelNavigation: true,
    });
  }

  /** A subresource the renderer needs to render (no-cors, credentials included). */
  async subresource(url, documentUrl) {
    return this.#send({ url, method: "GET", headers: [], body: null }, {
      credentials: "include", site: siteOf(documentUrl),
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
  async pageFetch(request, documentUrl) {
    const origin = new URL(documentUrl).origin;
    const url = new URL(request.url);
    const method = String(request.method ?? "GET").toUpperCase();
    const mode = request.mode ?? "cors";
    const credentials = request.credentials ?? "same-origin";
    if (FORBIDDEN_METHODS.has(method)) throw new TypeError(`Forbidden method ${method}`);
    if (!["http:", "https:"].includes(url.protocol)) throw new TypeError(`Fetch API cannot load ${url.protocol} URLs`);
    const headers = (request.headers ?? [])
      .map(([name, value]) => [String(name).toLowerCase(), String(value)])
      .filter(([name]) => !FORBIDDEN_REQUEST_HEADERS.has(name) && !name.startsWith("proxy-") && !name.startsWith("sec-"));
    const sameOrigin = url.origin === origin;
    if (mode === "same-origin" && !sameOrigin) throw new TypeError("Request was blocked: mode is same-origin");
    if (mode === "no-cors" && !SIMPLE_METHODS.has(method)) throw new TypeError(`${method} is not allowed in no-cors mode`);

    const sendCredentials = credentials === "include" || (credentials === "same-origin" && sameOrigin);
    const context = { credentials: sendCredentials ? "include" : "omit", site: siteOf(documentUrl), origin };

    if (sameOrigin) {
      return this.#send({ url: url.href, method, headers, body: request.body ?? null }, context, {
        redirect: request.redirect ?? "follow", corsOrigin: null,
      });
    }
    if (mode === "no-cors") {
      const response = await this.#send({ url: url.href, method, headers: headers.filter(isSafelistedHeader), body: request.body ?? null },
        context, { redirect: "follow", corsOrigin: null });
      return { ...response, type: "opaque", status: 0, statusText: "", url: "", headers: [], body: new Uint8Array(0), redirected: false };
    }
    // CORS: preflight unless the request is "simple" (Fetch §4.8).
    const needsPreflight = !SIMPLE_METHODS.has(method) || headers.some((header) => !isSafelistedHeader(header));
    if (needsPreflight) await this.#preflight(url, method, headers, origin, context);
    const response = await this.#send({ url: url.href, method, headers, body: request.body ?? null }, context, {
      redirect: request.redirect ?? "follow", corsOrigin: origin,
    });
    const allowed = corsAllowed(response.rawHeaders, origin, context.credentials === "include");
    if (!allowed) throw new TypeError(`CORS: ${url.href} did not allow origin ${origin}`);
    const exposed = new Set((header(response.rawHeaders, "access-control-expose-headers") ?? "")
      .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
    const exposeAll = exposed.has("*") && context.credentials !== "include";
    return {
      ...response,
      type: "cors",
      headers: response.headers.filter(([name]) => SAFELISTED_RESPONSE_HEADERS.has(name) || exposed.has(name) || exposeAll),
    };
  }

  async #preflight(url, method, headers, origin, context) {
    const requestHeaders = headers.filter((entry) => !isSafelistedHeader(entry)).map(([name]) => name).sort();
    const response = await this.#request(url.href, {
      method: "OPTIONS",
      redirect: "manual",
      headers: {
        origin,
        "access-control-request-method": method,
        ...(requestHeaders.length ? { "access-control-request-headers": requestHeaders.join(",") } : {}),
        ...(this.#userAgent ? { "user-agent": this.#userAgent } : {}),
      },
    });
    await response.arrayBuffer().catch(() => {});
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
      if (!allowHeaders.includes(name) && !(wildcard && allowHeaders.includes("*"))) {
        throw new TypeError(`CORS preflight for ${url.href} does not allow header ${name}`);
      }
    }
  }

  #request(url, init) {
    return this.#resolver ? fetchResolved(this.#fetch, this.#resolver, url, init) : this.#fetch(url, init);
  }

  /** Sends a request, following redirects by hand so cookies apply to every hop. */
  async #send(request, context, { redirect = "follow", corsOrigin = null } = {}) {
    let { url, method, body } = request;
    const baseHeaders = request.headers;
    let redirected = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers(baseHeaders);
      if (this.#userAgent) headers.set("user-agent", this.#userAgent);
      if (corsOrigin) headers.set("origin", corsOrigin);
      if (context.credentials === "include") {
        const cookie = this.#cookies.header(url, {
          site: context.site, topLevelNavigation: Boolean(context.topLevelNavigation), method,
        });
        if (cookie) headers.set("cookie", cookie);
      }
      const response = await this.#request(url, { method, headers, body, redirect: "manual" });
      if (context.credentials === "include") this.#cookies.store(url, response.headers.getSetCookie?.() ?? []);
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.arrayBuffer().catch(() => {});
        if (redirect === "error") throw new TypeError("Redirect was not allowed");
        if (redirect === "manual") return this.#result(response, url, redirected, "opaqueredirect");
        const next = new URL(location, url);
        if (!["http:", "https:"].includes(next.protocol)) throw new TypeError(`Redirect to ${next.protocol} is not allowed`);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = null;
        }
        url = next.href;
        redirected = true;
        continue;
      }
      return this.#result(response, url, redirected, "basic");
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
}

function isSafelistedHeader([name, value]) {
  if (!SAFELISTED_REQUEST_HEADERS.has(name)) return false;
  if (name === "content-type") return SIMPLE_CONTENT_TYPES.has(value.split(";")[0].trim().toLowerCase());
  return value.length <= 128;
}

function header(rawHeaders, name) {
  return rawHeaders.find(([key]) => key === name)?.[1] ?? null;
}

/** Fetch §4.9 CORS check. */
function corsAllowed(rawHeaders, origin, withCredentials) {
  const allowOrigin = header(rawHeaders, "access-control-allow-origin");
  if (allowOrigin === null) return false;
  if (allowOrigin === "*") return !withCredentials;
  if (allowOrigin !== origin) return false;
  return !withCredentials || header(rawHeaders, "access-control-allow-credentials") === "true";
}

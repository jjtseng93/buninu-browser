/**
 * An RFC 6265 cookie store for the controller.
 *
 * Parsing is done here rather than with Bun.Cookie because Bun.Cookie fills
 * in Path=/ and SameSite=Lax when they are absent, and RFC 6265 needs to know
 * whether they were given (default-path, §5.1.4). Sites are approximated as
 * the last two host labels because no Public Suffix List is bundled; IP
 * addresses and single-label hosts are their own site.
 */
export class CookieJar {
  #cookies = [];
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  /** Stores Set-Cookie header values received for `url`. `fromScript` rejects HttpOnly (document.cookie). */
  store(url, setCookies, { fromScript = false } = {}) {
    const target = new URL(url);
    for (const header of setCookies) {
      const cookie = parseSetCookie(header, target, this.#now());
      if (!cookie) continue;
      if (fromScript && cookie.httpOnly) continue;
      if (cookie.secure && target.protocol !== "https:" && !isLocalhost(target.hostname)) continue;
      const existing = this.#cookies.findIndex((entry) =>
        entry.name === cookie.name && entry.domain === cookie.domain && entry.path === cookie.path);
      if (existing >= 0) {
        // A script may not overwrite an HttpOnly cookie (RFC 6265bis §5.6).
        if (fromScript && this.#cookies[existing].httpOnly) continue;
        cookie.created = this.#cookies[existing].created;
        this.#cookies.splice(existing, 1);
      }
      if (cookie.expires <= this.#now()) continue;
      this.#cookies.push(cookie);
    }
  }

  /**
   * The Cookie header value for a request.
   * @param {string} url request URL
   * @param {{ site?: string | null, topLevelNavigation?: boolean, method?: string, includeHttpOnly?: boolean }} context
   *   `site` is the site of the document making the request (null for browser-initiated navigations).
   */
  header(url, { site = null, topLevelNavigation = false, method = "GET", includeHttpOnly = true } = {}) {
    const target = new URL(url);
    const now = this.#now();
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires > now);
    const crossSite = site !== null && siteOf(target) !== site;
    const selected = this.#cookies.filter((cookie) => {
      if (!domainMatches(cookie, target.hostname)) return false;
      if (!pathMatches(cookie.path, target.pathname || "/")) return false;
      if (cookie.secure && target.protocol !== "https:" && !isLocalhost(target.hostname)) return false;
      if (!includeHttpOnly && cookie.httpOnly) return false;
      if (crossSite) {
        if (cookie.sameSite === "strict") return false;
        const safeMethod = ["GET", "HEAD"].includes(method.toUpperCase());
        if (cookie.sameSite !== "none" && !(topLevelNavigation && safeMethod)) return false;
      }
      return true;
    });
    // Longer paths first, then earlier creation (§5.4 step 2).
    selected.sort((left, right) => right.path.length - left.path.length || left.created - right.created);
    return selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** document.cookie for a document URL: same-site, non-HttpOnly. */
  documentCookie(url) {
    return this.header(url, { includeHttpOnly: false });
  }

  get size() {
    return this.#cookies.length;
  }
}

/** Site of a URL: scheme plus registrable-domain approximation. */
export function siteOf(url) {
  const target = typeof url === "string" ? new URL(url) : url;
  if (target.protocol !== "http:" && target.protocol !== "https:") return `${target.protocol}opaque`;
  const host = target.hostname;
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return `${target.protocol}//${host}`;
  return `${target.protocol}//${host.split(".").slice(-2).join(".")}`;
}

function parseSetCookie(header, url, now) {
  const [pair, ...attributes] = String(header).split(";");
  const equals = pair.indexOf("=");
  if (equals < 0) return null;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name) return null;
  const cookie = {
    name,
    value,
    domain: url.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultPath(url),
    expires: Infinity,
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    created: now,
  };
  let maxAge = null;
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const argument = index < 0 ? "" : attribute.slice(index + 1).trim();
    switch (key) {
      case "expires": {
        const time = Date.parse(argument);
        if (Number.isFinite(time)) cookie.expires = time;
        break;
      }
      case "max-age":
        if (/^-?\d+$/.test(argument)) maxAge = Number(argument);
        break;
      case "domain": {
        const domain = argument.replace(/^\./, "").toLowerCase();
        if (!domain) break;
        // A cookie may only be set for the request host or a parent domain.
        if (!hostMatchesDomain(url.hostname.toLowerCase(), domain)) return null;
        cookie.domain = domain;
        cookie.hostOnly = false;
        break;
      }
      case "path":
        if (argument.startsWith("/")) cookie.path = argument;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite": {
        const mode = argument.toLowerCase();
        if (["strict", "lax", "none"].includes(mode)) cookie.sameSite = mode;
        break;
      }
      default:
        break;
    }
  }
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? -Infinity : now + maxAge * 1000;
  // SameSite=None requires Secure.
  if (cookie.sameSite === "none" && !cookie.secure) cookie.sameSite = "lax";
  return cookie;
}

/** RFC 6265 §5.1.4 default-path: the request path up to (not including) its last "/". */
function defaultPath(url) {
  const path = url.pathname || "/";
  if (!path.startsWith("/")) return "/";
  const last = path.lastIndexOf("/");
  return last <= 0 ? "/" : path.slice(0, last);
}

function hostMatchesDomain(host, domain) {
  return host === domain || (host.endsWith(`.${domain}`) && !/^[\d.]+$/.test(host));
}

function domainMatches(cookie, host) {
  const hostname = host.toLowerCase();
  return cookie.hostOnly ? hostname === cookie.domain : hostMatchesDomain(hostname, cookie.domain);
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatches(cookiePath, requestPath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function isLocalhost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

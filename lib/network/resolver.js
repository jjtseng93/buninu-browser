/**
 * Host resolution for the controller's network service.
 *
 * glibc's getaddrinfo() for an unspecified family sends the A and AAAA
 * queries at the same moment from one UDP socket. Some network paths (NAT
 * and connection tracking, as on phones and in containers) drop one of two
 * such packets, and the resolver then waits its full timeout, 5 seconds by
 * default, before retrying. The usual cure is `options single-request-reopen`
 * in /etc/resolv.conf, which a browser cannot count on.
 *
 * So each family is looked up on its own (one query per getaddrinfo call,
 * each with its own socket), and requests connect to an address directly
 * while keeping the host name for the Host header and for TLS (SNI and
 * certificate verification). This also covers musl, which has no such option.
 *
 * `localhost` and `*.localhost` are loopback without asking anyone (RFC 6761
 * §6.3, as Chrome and Bun's own socket resolver do): node:dns hands them to
 * the system getaddrinfo(), which needs an /etc/hosts entry that minimal
 * systems (an initramfs, containers) may not have.
 */
import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TTL_MS = 60_000;
const LOOPBACK = Object.freeze([
  Object.freeze({ address: "127.0.0.1", family: 4 }),
  Object.freeze({ address: "::1", family: 6 }),
]);
// Errors that mean "this address did not answer": try the next one.
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
  "ConnectionRefused", "FailedToOpenSocket", "NetworkUnreachable", "HostUnreachable", "ConnectionTimedOut",
]);

export class HostResolver {
  #cache = new Map();
  #lookup;
  #ttl;
  #now;

  /**
   * @param {{ lookup?: typeof systemLookup, ttl?: number, now?: () => number }} options
   */
  constructor({ lookup = systemLookup, ttl = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.#lookup = lookup;
    this.#ttl = ttl;
    this.#now = now;
  }

  /** Addresses for a host name, IPv4 first, then IPv6. */
  addresses(hostname) {
    const name = hostname.toLowerCase();
    if (isLocalhostName(name)) return Promise.resolve(LOOPBACK);
    const cached = this.#cache.get(name);
    if (cached && cached.expires > this.#now()) return cached.addresses;
    const addresses = this.#resolve(name);
    this.#cache.set(name, { addresses, expires: this.#now() + this.#ttl });
    // A failed lookup is not remembered.
    addresses.catch(() => {
      if (this.#cache.get(name)?.addresses === addresses) this.#cache.delete(name);
    });
    return addresses;
  }

  async #resolve(name) {
    const [v4, v6] = await Promise.allSettled([
      this.#lookup(name, { family: 4, all: true }),
      this.#lookup(name, { family: 6, all: true }),
    ]);
    const addresses = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ].map(({ address, family }) => ({ address, family }));
    if (!addresses.length) {
      const error = new TypeError(`Unable to resolve ${name}`);
      error.code = "ENOTFOUND";
      throw error;
    }
    return addresses;
  }
}

/** `localhost` or a name under `.localhost` (one trailing dot allowed), lowercase. */
export function isLocalhostName(name) {
  const host = name.endsWith(".") ? name.slice(0, -1) : name;
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * fetch() that connects to a resolved address, keeping the host name for the
 * Host header and TLS. IP literals and non-HTTP URLs go to `fetchImpl` as is.
 */
export async function fetchResolved(fetchImpl, resolver, url, init = {}) {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!["http:", "https:"].includes(target.protocol) || isIP(hostname)) return fetchImpl(url, init);
  const addresses = await resolver.addresses(hostname);
  let lastError;
  for (const { address, family } of addresses) {
    const direct = new URL(target.href);
    direct.hostname = family === 6 ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set("host", target.host);
    const tls = target.protocol === "https:" ? { ...init.tls, serverName: hostname } : init.tls;
    try {
      return await fetchImpl(direct.href, { ...init, headers, ...(tls ? { tls } : {}) });
    } catch (error) {
      if (!CONNECT_ERRORS.has(error?.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

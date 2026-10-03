import { afterAll, beforeAll, expect, test } from "bun:test";
import { CookieJar, siteOf } from "../lib/network/cookie-jar.js";
import { NetworkService } from "../lib/network/network-service.js";

let server;
let seen;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        cookie: request.headers.get("cookie"),
        origin: request.headers.get("origin"),
        custom: request.headers.get("x-custom"),
      });
      const cors = (extra = {}) => ({ "access-control-allow-origin": url.searchParams.get("allow") ?? "", ...extra });
      switch (url.pathname) {
        case "/login":
          return new Response(null, {
            status: 302,
            headers: [["location", "/home"], ["set-cookie", "sid=1; Path=/; HttpOnly"], ["set-cookie", "theme=dark; Path=/"],
              ["set-cookie", "strict=1; Path=/; SameSite=Strict"], ["set-cookie", "none=1; Path=/; SameSite=None; Secure"]],
          });
        case "/home":
          return new Response("home");
        case "/app/deep/set":
          return new Response("ok", { headers: [["set-cookie", "scoped=1"]] });
        case "/api/simple":
          return new Response("simple", { headers: cors({ "x-secret": "hidden", "x-exposed": "shown", "access-control-expose-headers": "x-exposed" }) });
        case "/api/credentialed":
          return new Response("credentialed", { headers: cors({ "access-control-allow-credentials": "true" }) });
        case "/api/preflighted":
          if (request.method === "OPTIONS") {
            return new Response(null, {
              status: 204,
              headers: cors({ "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom" }),
            });
          }
          return new Response(`put:${request.headers.get("x-custom")}`, { headers: cors() });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
});
afterAll(() => server?.stop(true));

const local = (path) => `http://localhost:${server.port}${path}`;
const loopback = (path) => `http://127.0.0.1:${server.port}${path}`;

test("follows redirects by hand and stores cookies on every hop", async () => {
  seen = [];
  const network = new NetworkService();
  const response = await network.navigate(local("/login"));
  expect(new TextDecoder().decode(response.body)).toBe("home");
  expect(response).toMatchObject({ redirected: true, url: local("/home"), status: 200 });
  // The redirect target already received the cookies set by the redirect.
  // localhost counts as potentially trustworthy, so Secure cookies apply over http (as in Chrome).
  expect(seen[1].cookie).toBe("sid=1; theme=dark; strict=1; none=1");
  // HttpOnly cookies are hidden from document.cookie; Set-Cookie never reaches pages.
  expect(network.documentCookie(local("/"))).toBe("theme=dark; strict=1; none=1");
  expect(response.headers.some(([name]) => name === "set-cookie")).toBeFalse();
});

test("applies the default path and SameSite to cross-site requests", async () => {
  seen = [];
  const network = new NetworkService();
  await network.navigate(local("/login"));
  await network.navigate(local("/app/deep/set"));
  // default-path of /app/deep/set is /app/deep.
  expect(network.cookies.header(local("/app/deep/x"))).toContain("scoped=1");
  expect(network.cookies.header(local("/app/other"))).not.toContain("scoped=1");
  // A subresource request from another site carries only SameSite=None cookies.
  seen = [];
  await network.subresource(local("/home"), loopback("/page"));
  expect(seen[0].cookie).toBe("none=1");
  // A top-level navigation from another site carries Lax (and None) but not Strict.
  expect(network.cookies.header(local("/home"), { site: siteOf(loopback("/")), topLevelNavigation: true }))
    .toBe("sid=1; theme=dark; none=1");
});

test("rejects cookies for foreign domains and expires Max-Age=0", () => {
  const jar = new CookieJar();
  jar.store("https://a.example.com/", ["x=1; Domain=example.org", "y=1; Domain=example.com", "z=1"]);
  expect(jar.header("https://b.example.com/")).toBe("y=1");
  expect(jar.header("https://a.example.com/")).toBe("y=1; z=1");
  jar.store("https://a.example.com/", ["z=gone; Max-Age=0"]);
  expect(jar.header("https://a.example.com/")).toBe("y=1");
  // Scripts cannot create HttpOnly cookies or overwrite existing ones.
  jar.store("https://a.example.com/", ["h=1; HttpOnly"]);
  jar.store("https://a.example.com/", ["h=2", "s=1; HttpOnly"], { fromScript: true });
  expect(jar.header("https://a.example.com/")).toBe("y=1; h=1");
});

test("enforces CORS for page fetches and filters exposed headers", async () => {
  seen = [];
  const network = new NetworkService();
  const document = loopback("/page");
  const origin = new URL(document).origin;
  const allowed = await network.pageFetch({ url: local(`/api/simple?allow=${encodeURIComponent(origin)}`) }, document);
  expect(allowed).toMatchObject({ type: "cors", status: 200 });
  expect(Object.fromEntries(allowed.headers)).toMatchObject({ "x-exposed": "shown" });
  expect(allowed.headers.some(([name]) => name === "x-secret")).toBeFalse();
  expect(seen[0].origin).toBe(origin);
  await expect(network.pageFetch({ url: local("/api/simple?allow=https://other.test") }, document)).rejects.toThrow("CORS");
  // no-cors gives an opaque response instead of an error.
  const opaque = await network.pageFetch({ url: local("/api/simple"), mode: "no-cors" }, document);
  expect(opaque).toMatchObject({ type: "opaque", status: 0, body: new Uint8Array(0) });
});

test("requires exact origin and allow-credentials for credentialed CORS", async () => {
  const network = new NetworkService();
  await network.navigate(local("/login"));
  const document = loopback("/page");
  const origin = new URL(document).origin;
  seen = [];
  const withCookies = await network.pageFetch(
    { url: local(`/api/credentialed?allow=${encodeURIComponent(origin)}`), credentials: "include" }, document);
  expect(withCookies.status).toBe(200);
  // Cross-site credentialed fetch: SameSite=None cookies only.
  expect(seen[0].cookie).toBe("none=1");
  await expect(network.pageFetch({ url: local("/api/credentialed?allow=*"), credentials: "include" }, document))
    .rejects.toThrow("CORS");
  // The default credentials mode sends no cookies cross-origin.
  seen = [];
  await network.pageFetch({ url: local(`/api/credentialed?allow=${encodeURIComponent(origin)}`) }, document);
  expect(seen[0].cookie).toBeNull();
});

test("preflights non-simple requests and strips forbidden headers", async () => {
  seen = [];
  const network = new NetworkService();
  const document = loopback("/page");
  const origin = new URL(document).origin;
  const response = await network.pageFetch({
    url: local(`/api/preflighted?allow=${encodeURIComponent(origin)}`),
    method: "PUT",
    headers: [["X-Custom", "v"], ["Cookie", "forged=1"], ["Host", "evil.test"]],
  }, document);
  expect(new TextDecoder().decode(response.body)).toBe("put:v");
  expect(seen.map((entry) => entry.method)).toEqual(["OPTIONS", "PUT"]);
  expect(seen[1].cookie).toBeNull();
  await expect(network.pageFetch({
    url: local(`/api/preflighted?allow=${encodeURIComponent(origin)}`), method: "DELETE",
  }, document)).rejects.toThrow("does not allow method DELETE");
  await expect(network.pageFetch({ url: "file:///etc/passwd" }, document)).rejects.toThrow("cannot load file:");
});

test("coalesces identical subresources, caches fresh bodies, and revalidates ETags", async () => {
  let freshRequests = 0;
  let validatedRequests = 0;
  const network = new NetworkService({ fetch: async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers ?? input.headers);
    if (url.pathname === "/fresh") {
      freshRequests++;
      await Bun.sleep(10);
      return new Response("fresh", { headers: { "cache-control": "public, max-age=60" } });
    }
    validatedRequests++;
    if (headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
    return new Response("validated", { headers: { "cache-control": "no-cache", etag: '"v1"' } });
  } });
  const document = "https://page.test/";
  const [left, right] = await Promise.all([
    network.subresource("https://asset.test/fresh", document),
    network.subresource("https://asset.test/fresh", document),
  ]);
  expect([new TextDecoder().decode(left.body), new TextDecoder().decode(right.body), freshRequests])
    .toEqual(["fresh", "fresh", 1]);
  await network.subresource("https://asset.test/fresh", document);
  expect(freshRequests).toBe(1);

  const first = await network.subresource("https://asset.test/revalidate", document);
  const second = await network.subresource("https://asset.test/revalidate", document);
  expect([new TextDecoder().decode(first.body), new TextDecoder().decode(second.body), validatedRequests])
    .toEqual(["validated", "validated", 2]);
});

test("at most six requests per host are in flight; waiting stylesheets go before scripts", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const gates = [];
  const network = new NetworkService({ fetch: async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    started.push(url.host + url.pathname);
    if (url.host === "slow.test") {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => gates.push(resolve));
      active--;
    }
    return new Response("x", { headers: { "cache-control": "no-store" } });
  } });
  const document = "https://page.test/";
  const scripts = Array.from({ length: 8 }, (_, index) => network.subresource(`https://slow.test/s${index}.js`, document, "script"));
  await Bun.sleep(5);
  const stylesheet = network.subresource("https://slow.test/late.css", document, "stylesheet");
  // Another host is not held up by this one's queue.
  await network.subresource("https://other.test/free.js", document, "script");
  expect(started.filter((entry) => entry.startsWith("slow.test"))).toHaveLength(6);
  gates.shift()();
  await Bun.sleep(5);
  // The freed slot went to the stylesheet that came after the waiting scripts.
  expect(started.at(-1)).toBe("slow.test/late.css");
  while (active || gates.length) {
    gates.shift()?.();
    await Bun.sleep(1);
  }
  await Promise.all([...scripts, stylesheet]);
  expect(peak).toBe(6);
  expect(started.filter((entry) => entry.startsWith("slow.test"))).toHaveLength(9);
});

/** Opens a page WebSocket and resolves with how it ended. */
function socketOutcome(socket) {
  return new Promise((resolve) => {
    socket.addEventListener("open", () => {
      resolve("open");
      socket.close();
    });
    socket.addEventListener("close", (event) => resolve(`closed ${event.code}`));
  });
}

test("page WebSockets always send an Origin, null for opaque documents", async () => {
  const origins = [];
  const echo = Bun.serve({
    port: 0,
    fetch(request, server) {
      origins.push(request.headers.get("origin"));
      return server.upgrade(request) ? undefined : new Response("no", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    const network = new NetworkService({ fetch: async () => new Response("") });
    for (const documentUrl of ["https://page.test/a", "data:text/html,x", "about:blank"]) {
      expect(await socketOutcome(network.webSocket(`ws://127.0.0.1:${echo.port}/`, [], documentUrl))).toBe("open");
    }
    expect(origins).toEqual(["https://page.test", "null", "null"]);
  } finally {
    echo.stop(true);
  }
});

test("a page cannot open the CDP endpoint, even from a data: or about:blank document", async () => {
  const { CdpServer } = await import("../lib/cdp-server.js");
  const cdp = new CdpServer({}).listen(0, "127.0.0.1");
  try {
    const network = new NetworkService({ fetch: async () => new Response("") });
    const url = `ws://127.0.0.1:${cdp.port}/devtools/browser/cdp-server`;
    for (const documentUrl of ["https://evil.test/", "data:text/html,x", "about:blank"]) {
      expect(await socketOutcome(network.webSocket(url, [], documentUrl))).toBe("closed 1002");
    }
    // A client without an Origin (casty, Playwright) still connects.
    expect(await socketOutcome(new WebSocket(url))).toBe("open");
  } finally {
    cdp.stop(true);
  }
});

test("/json/new opens a target on PUT only", async () => {
  const { CdpServer } = await import("../lib/cdp-server.js");
  const cdp = new CdpServer({}).listen(0, "127.0.0.1");
  try {
    const base = `http://127.0.0.1:${cdp.port}`;
    const get = await fetch(`${base}/json/new?about:blank`);
    expect(get.status).toBe(405);
    expect(await (await fetch(`${base}/json/list`)).json()).toEqual([]);
    const put = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
    expect(put.status).toBe(200);
    expect((await put.json()).webSocketDebuggerUrl).toContain("/devtools/page/");
  } finally {
    cdp.stop(true);
  }
});

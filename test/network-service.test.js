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

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
        case "/moved":
          return new Response("moved here", { status: 301, headers: { location: "/home", ...cors() } });
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

test("navigation metadata distinguishes browser UI from page-initiated navigation", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "https://other.test/end" } })
      : new Response("ok");
  } });
  await network.navigate("https://example.test/start");
  for (const { headers } of calls) {
    expect(headers.get("sec-fetch-mode")).toBe("navigate");
    expect(headers.get("sec-fetch-dest")).toBe("document");
    expect(headers.get("sec-fetch-site")).toBe("none");
    expect(headers.has("sec-fetch-user")).toBeFalse();
  }
  calls.length = 0;
  await network.navigate("https://example.test/end", { referrer: "https://example.test/page#section" });
  expect(calls[0].headers.get("sec-fetch-site")).toBe("same-origin");
  expect(calls[0].headers.get("referer")).toBe("https://example.test/page");
  await network.navigate("https://example.test:8443/end", { referrer: "https://example.test/page" });
  expect(calls[1].headers.get("sec-fetch-site")).toBe("same-site");
  expect(calls[1].headers.get("referer")).toBe("https://example.test/");
});

test("resource destinations are separated while referrer-independent cache entries survive navigation", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push(headers);
    return new Response(headers.get("sec-fetch-dest"), { headers: { "cache-control": "max-age=60" } });
  } });
  await network.subresource("https://example.test/asset", "https://example.test/page", "script");
  await network.subresource("https://example.test/asset", "https://example.test/page", "image");
  await network.subresource("https://example.test/asset", "https://example.test/other", "image");
  await network.subresource("https://example.test/asset", "https://example.test/other", "image");
  expect(calls).toHaveLength(2);
  expect(calls.map(headers => headers.get("sec-fetch-dest"))).toEqual(["script", "image"]);
  expect(calls[0].get("sec-fetch-mode")).toBe("no-cors");
  expect(calls[1].get("referer")).toBe("https://example.test/page");
});

test("Vary: Referer isolates representations and validators across documents", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers); calls.push(headers);
    return new Response(headers.get("referer"), { headers: { "cache-control": "max-age=60", vary: "Referer", etag: '"page"' } });
  } });
  await network.subresource("https://example.test/image", "https://example.test/one", "image");
  const other = await network.subresource("https://example.test/image", "https://example.test/two", "image");
  await network.subresource("https://example.test/image", "https://example.test/two", "image");
  expect(calls).toHaveLength(2);
  expect(calls[1].has("if-none-match")).toBeFalse();
  expect(new TextDecoder().decode(other.body)).toBe("https://example.test/two");
});

test("a cacheable final body does not cache a credential-dependent redirect", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/entry')) return new Response(null, { status:302, headers:{location:'https://asset.test/final', 'cache-control':'no-store'} });
    return new Response(new Headers(init.headers).get('cookie') ?? 'anonymous', { headers:{'cache-control':'max-age=60'} });
  }});
  expect(new TextDecoder().decode((await network.subresource('https://page.test/entry','https://page.test/')).body)).toBe('anonymous');
  network.setDocumentCookie('https://asset.test/','session=changed; SameSite=None; Secure');
  expect(new TextDecoder().decode((await network.subresource('https://page.test/entry','https://page.test/')).body)).toBe('session=changed');
  expect(calls.length).toBe(4);
});

test("CORS header value rules distinguish simple values from preflighted ones", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers); calls.push({method:init.method, headers});
    return new Response('ok', {headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-max-age':'0'}});
  }});
  const check = async (name, value, preflight) => {
    calls.length = 0;
    await network.pageFetch({url:'https://asset.test/api', headers:[[name,value]]},'https://page.test/');
    expect(calls.map(call=>call.method)).toEqual(preflight ? ['OPTIONS','GET'] : ['GET']);
    if (preflight) expect(calls[0].headers.get('access-control-request-headers')).toBe(name);
  };
  await check('accept','text/html, */*;q=0.8',false);
  await check('accept','text/html;variant="wide"',true);
  await check('accept-language','en-US, zh-TW;q=0.8',false);
  await check('accept-language','en_US',true);
  await check('content-type','text/plain;charset=utf-8',false);
  await check('content-type','text/plain;charset="utf-8"',true);
  await check('content-type','text/plain;'+ 'a'.repeat(128),true);
  await check('range','bytes=0-99',false);
  await check('range','bytes=100-',false);
  await check('range','bytes=-99',true);
  await check('range','bytes=100-99',true);
  await check('range','bytes=0-99,200-299',true);
  calls.length=0;
  await network.pageFetch({url:'https://page.test/api',mode:'no-cors',headers:[['range','bytes=0-99'],['accept-language','en_US'],['accept','text/plain']]},'https://page.test/');
  expect(calls[0].headers.get('range')).toBeNull();
  expect(calls[0].headers.get('accept-language')).toBeNull();
  expect(calls[0].headers.get('accept')).toBe('text/plain');
});

test("Fetch Metadata is trustworthy-only and cannot be forged by page headers", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    calls.push(new Headers(init.headers));
    return new Response("ok");
  } });
  await network.pageFetch({ url: "https://example.test/api", mode: "same-origin",
    headers: [["sec-fetch-mode", "navigate"], ["sec-fetch-site", "none"], ["sec-fetch-user", "?1"]] }, "https://example.test/page");
  expect(calls[0].get("sec-fetch-mode")).toBe("same-origin");
  expect(calls[0].get("sec-fetch-site")).toBe("same-origin");
  expect(calls[0].get("sec-fetch-dest")).toBe("empty");
  expect(calls[0].has("sec-fetch-user")).toBeFalse();
  await network.navigate("http://example.test/page");
  expect(calls[1].has("sec-fetch-mode")).toBeFalse();
  await network.navigate("http://localhost/page");
  expect(calls[2].get("sec-fetch-mode")).toBe("navigate");
});

test("a redirect cannot regain same-origin metadata or leak a full referrer", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    calls.push(new Headers(init.headers));
    const redirects = { "https://example.test/start": "http://localhost/middle", "http://localhost/middle": "https://example.test/end" };
    return redirects[url] ? new Response(null, { status: 302, headers: { location: redirects[url] } }) : new Response("ok");
  } });
  await network.navigate("https://example.test/start", { referrer: "https://example.test/private#anchor" });
  expect(calls.map(headers => headers.get("sec-fetch-site"))).toEqual(["same-origin", "cross-site", "cross-site"]);
  // Loopback HTTP is potentially trustworthy. A cross-origin hop trims the
  // path; returning to the original origin must not restore it.
  expect(calls[1].get("referer")).toBe("https://example.test/");
  expect(calls[2].get("referer")).toBe("https://example.test/");
  calls.length = 0;
  await network.navigate("https://other.test/end", { post: { body: "a=b", contentType: "application/x-www-form-urlencoded",
    referrer: "https://example.test/private#anchor" } });
  expect(calls[0].get("referer")).toBe("https://example.test/");
  expect(calls[0].get("origin")).toBe("https://example.test");
});

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

test("a manual redirect gives the page an opaque-redirect response", async () => {
  seen = [];
  const network = new NetworkService();
  const same = await network.pageFetch({ url: local("/moved"), redirect: "manual" }, local("/"));
  expect(same).toMatchObject({ type: "opaqueredirect", status: 0, url: "", headers: [] });
  expect(same.body.byteLength).toBe(0);
  // Cross-origin: the redirect still passes the CORS check.
  const cross = await network.pageFetch({ url: local(`/moved?allow=${encodeURIComponent(loopback(""))}`), redirect: "manual" }, loopback("/"));
  expect(cross).toMatchObject({ type: "opaqueredirect", status: 0 });
  expect(seen.map((entry) => entry.path)).toEqual(["/moved", "/moved"]);
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

test("revalidation updates cached headers and validator; no-cache overrides max-age", async () => {
  const validators = [];
  const network = new NetworkService({ fetch: async (_, init) => {
    const etag = new Headers(init.headers).get('if-none-match'); validators.push(etag);
    if (validators.length === 1) return new Response('body', { headers: { etag: '"v1"', 'cache-control': 'max-age=60, no-cache' } });
    return new Response(null, { status: 304, headers: { etag: '"v2"', 'x-version': '2' } });
  } });
  for (let i = 0; i < 3; i++) {
    const r = await network.subresource('https://a.test/style.css','https://a.test/');
    expect(new TextDecoder().decode(r.body)).toBe('body');
    if (i) expect(r.headers).toContainEqual(['x-version','2']);
  }
  expect(validators).toEqual([null,'"v1"','"v2"']);
});

test("Last-Modified validates without ETag; Vary:* and no-store responses are never retained", async () => {
  const seen = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    seen.push([url,new Headers(init.headers).get('if-modified-since')]);
    if (url.endsWith('/modified')) return new Response('x',{headers:{'last-modified':'Wed, 01 Jan 2025 00:00:00 GMT'}});
    return new Response('x',{headers:{'cache-control':url.endsWith('/star')?'max-age=60':'no-store, max-age=60',vary:'*'}});
  } });
  for (const path of ['modified','star','store']) for(let i=0;i<2;i++)await network.subresource(`https://a.test/${path}`,'https://a.test/');
  expect(seen).toHaveLength(6);
  expect(seen[1][1]).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
});

test("cache byte budget evicts least-recently-used data and does not retain oversized bodies", async () => {
  const calls=[];
  const network=new NetworkService({maxSubresourceCacheBytes:8,fetch:async url=>{
    calls.push(url);return new Response(url.endsWith('/large')?'0123456789':'1234',{headers:{'cache-control':'max-age=60'}});
  }});
  const get=path=>network.subresource('https://a.test/'+path,'https://a.test/');
  await get('a');await get('b');await get('a');await get('c');await get('a');await get('b');
  expect(calls.map(u=>u.split('/').at(-1))).toEqual(['a','b','c','b']);
  await get('large');await get('large');expect(calls.filter(u=>u.endsWith('/large'))).toHaveLength(2);
});

test("Age and Date reduce freshness, and immutable alone does not invent a lifetime", async () => {
  let calls=0;
  const network=new NetworkService({fetch:async url=>{
    calls++;return new Response('x',{headers:url.endsWith('/immutable')?{'cache-control':'immutable'}:{'cache-control':'max-age=60',age:'120'}});
  }});
  for(const path of ['aged','immutable'])for(let i=0;i<2;i++)await network.subresource(`https://a.test/${path}`,'https://a.test/');
  expect(calls).toBe(4);
});

test("aborting a queued page fetch releases it without waiting for busy host slots", async () => {
  const gates=[];const calls=[];
  const network=new NetworkService({fetch:async url=>{
    calls.push(url);await new Promise(resolve=>gates.push(resolve));return new Response('ok');
  }});
  const document='https://busy.test/';
  const active=Array.from({length:6},(_,i)=>network.pageFetch({url:document+i},document));
  while(gates.length<6)await Bun.sleep(1);
  const controller=new AbortController();
  const queued=network.pageFetch({url:document+'aborted'},document,{signal:controller.signal});
  controller.abort(new Error('cancelled navigation'));
  await expect(queued).rejects.toThrow('cancelled navigation');
  expect(calls).toHaveLength(6);
  for(const finish of gates)finish();await Promise.all(active);
  expect(calls.some(url=>url.endsWith('/aborted'))).toBe(false);
});

test("successful CORS preflights reuse permission without caching API responses or crossing origins", async () => {
  const calls=[];
  const network=new NetworkService({fetch:async (url,init)=>{
    const headers=new Headers(init.headers);calls.push([url,init.method,headers.get('access-control-request-headers')]);
    return new Response(init.method==='OPTIONS'?null:'live '+calls.length,{headers:{
      'access-control-allow-origin':headers.get('origin'), 'access-control-allow-credentials':'true',
      'access-control-allow-methods':'PUT, DELETE','access-control-allow-headers':'x-token,x-extra',
      'access-control-max-age':'60',
    }});
  }});
  const request={url:'https://api.test/items',method:'PUT',headers:[['x-token','one']]};
  const first=await network.pageFetch(request,'https://page.test/');
  const second=await network.pageFetch({...request,headers:[['x-token','two']]},'https://page.test/next');
  expect(new TextDecoder().decode(first.body)).not.toBe(new TextDecoder().decode(second.body));
  expect(calls.map(c=>c[1])).toEqual(['OPTIONS','PUT','PUT']);
  await network.pageFetch(request,'https://other.test/');
  await network.pageFetch({...request,credentials:'include'},'https://page.test/');
  await network.pageFetch({...request,url:request.url+'/other'},'https://page.test/');
  await network.pageFetch({...request,method:'DELETE'},'https://page.test/');
  await network.pageFetch({...request,headers:[...request.headers,['x-extra','value']]},'https://page.test/');
  expect(calls.filter(c=>c[1]==='OPTIONS')).toHaveLength(6);
});

test("CORS preflight grants expire and max-age zero does not cache", async () => {
  let preflights=0;
  const network=new NetworkService({fetch:async (url,init)=>{
    if(init.method==='OPTIONS')preflights++;
    return new Response(null,{headers:{'access-control-allow-origin':'*','access-control-allow-methods':'PUT',
      'access-control-max-age':url.endsWith('zero')?'0':'1'}});
  }});
  const get=path=>network.pageFetch({url:'https://api.test/'+path,method:'PUT'},'https://page.test/');
  await get('one');await get('one');expect(preflights).toBe(1);
  await Bun.sleep(1050);await get('one');expect(preflights).toBe(2);
  await get('zero');await get('zero');expect(preflights).toBe(4);
});

test("wildcard CORS permissions do not authorize Authorization, and denied grants are not cached", async () => {
  let calls=0;
  const network=new NetworkService({fetch:async()=>{calls++;return new Response(null,{headers:{
    'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-max-age':'60',
  }});}});
  const request={url:'https://api.test/',headers:[['Authorization','Bearer example']]};
  for(let i=0;i<2;i++)await expect(network.pageFetch(request,'https://page.test/')).rejects.toThrow('does not allow header authorization');
  expect(calls).toBe(2);
});

test("an aborted CORS preflight does not send the API request or cache a grant",async()=>{
  let calls=0;
  const network=new NetworkService({fetch:async(_,init)=>{
    calls++;await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  }});
  const controller=new AbortController();
  const pending=network.pageFetch({url:'https://api.test/',method:'PUT'},'https://page.test/',{signal:controller.signal});
  while(calls===0)await Bun.sleep(1);
  controller.abort(new Error('cancelled preflight'));
  await expect(pending).rejects.toThrow('cancelled preflight');expect(calls).toBe(1);
});

test("aborting a preflight after headers arrive does not retain its permission grant", async () => {
  const calls = [];
  let headersArrived = false;
  const network = new NetworkService({ fetch: async (url, init) => {
    calls.push(init.method);
    const body = calls.length === 1 ? new ReadableStream({ start(controller) {
      headersArrived = true;
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {once:true});
    }}) : null;
    return new Response(body,{headers:{'access-control-allow-origin':'*','access-control-allow-methods':'PUT','access-control-max-age':'60'}});
  }});
  const controller = new AbortController();
  const request = {url:'https://api.test/',method:'PUT'};
  const pending = network.pageFetch(request,'https://page.test/',{signal:controller.signal});
  while (!headersArrived) await Bun.sleep(1);
  controller.abort(new Error('cancelled after headers'));
  await expect(pending).rejects.toThrow('cancelled after headers');
  await network.pageFetch(request,'https://page.test/');
  expect(calls).toEqual(['OPTIONS','OPTIONS','PUT']);
});

test("same-origin fetch redirects still enforce CORS, credentials and response-header filtering", async () => {
  const calls = [];
  let allowed = false;
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers); calls.push({ url, headers });
    if (url === "https://source.test/start") return new Response(null, { status: 302, headers: { location: "https://target.test/data" } });
    return new Response("public", { headers: { ...(allowed ? { "access-control-allow-origin": "https://source.test" } : {}),
      "x-secret": "hidden", "x-public": "visible", "access-control-expose-headers": "x-public" } });
  } });
  network.cookies.store("https://target.test/", ["secret=credential; Secure; SameSite=None"]);
  await expect(network.pageFetch({ url: "https://source.test/start" }, "https://source.test/page")).rejects.toThrow("CORS");
  expect(calls[1].headers.get("cookie")).toBeNull();
  expect(calls[1].headers.get("origin")).toBe("https://source.test");
  allowed = true;
  const response = await network.pageFetch({ url: "https://source.test/start" }, "https://source.test/page");
  expect(response.type).toBe("cors");
  expect(new Headers(response.headers).get("x-secret")).toBeNull();
  expect(new Headers(response.headers).get("x-public")).toBe("visible");
});

test("same-origin mode blocks a cross-origin redirect before contacting its target", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: "https://target.test/private" } });
  } });
  await expect(network.pageFetch({ url: "https://source.test/start", mode: "same-origin" }, "https://source.test/page"))
    .rejects.toThrow("mode is same-origin");
  expect(calls).toEqual(["https://source.test/start"]);
});

test("no-cors fetches become opaque when a redirect crosses origins", async () => {
  const network = new NetworkService({ fetch: async url => url.includes("source.test")
    ? new Response(null, { status: 302, headers: { location: "https://target.test/private" } })
    : new Response("private", { headers: { "x-private": "secret" } }) });
  const result = await network.pageFetch({ url: "https://source.test/start", mode: "no-cors" }, "https://source.test/page");
  expect(result).toMatchObject({ type: "opaque", status: 0, url: "", headers: [], redirected: false });
  expect(result.body.byteLength).toBe(0);
});

test("redirected non-simple requests preflight the new origin and strip Authorization", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers); calls.push({ url, method: init.method, headers });
    if (url.includes("source.test")) return new Response(null, { status: 307, headers: { location: "https://target.test/api" } });
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "https://source.test",
      "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom" } });
  } });
  await network.pageFetch({ url: "https://source.test/start", method: "PUT", body: new TextEncoder().encode("body"),
    headers: [["authorization", "Bearer private"], ["x-custom", "value"]] }, "https://source.test/page");
  expect(calls.map(call => call.method)).toEqual(["PUT", "OPTIONS", "PUT"]);
  expect(calls[0].headers.get("authorization")).toBe("Bearer private");
  expect(calls[1].headers.get("access-control-request-headers")).toBe("x-custom");
  expect(calls[2].headers.has("authorization")).toBeFalse();
});

test("a cross-origin redirect chain checks each hop and taints subsequent Origin", async () => {
  const calls = [];
  const network = new NetworkService({ fetch: async (url, init) => {
    const headers = new Headers(init.headers); calls.push({ url, headers });
    if (url === "https://target.test/start") return new Response(null, { status: 302, headers: {
      location: "https://final.test/end", "access-control-allow-origin": "https://source.test" } });
    return new Response("done", { headers: { "access-control-allow-origin": "null" } });
  } });
  const result = await network.pageFetch({ url: "https://target.test/start" }, "https://source.test/page");
  expect(result.type).toBe("cors");
  expect(calls.map(call => call.headers.get("origin"))).toEqual(["https://source.test", "null"]);
});

test("canceling one coalesced resource consumer preserves other consumers", async () => {
  let requests = 0, underlyingAborted = false, complete;
  const network = new NetworkService({ fetch: async (url, init) => {
    requests++;
    return new Promise((resolve, reject) => {
      complete = () => resolve(new Response("shared image"));
      init.signal.addEventListener("abort", () => { underlyingAborted = true; reject(init.signal.reason); }, { once: true });
    });
  } });
  const first = new AbortController(), second = new AbortController();
  const one = network.subresource("https://example.test/image", "https://example.test/page", "image", { signal: first.signal });
  const two = network.subresource("https://example.test/image", "https://example.test/page", "image", { signal: second.signal });
  await Bun.sleep(0);
  first.abort("first document closed");
  await expect(one).rejects.toBe("first document closed");
  expect(underlyingAborted).toBeFalse();
  complete();
  expect(new TextDecoder().decode((await two).body)).toBe("shared image");
  expect(requests).toBe(1);
  expect(underlyingAborted).toBeFalse();
});

test("the last resource consumer aborts its transfer and a later consumer starts fresh", async () => {
  let requests = 0, aborts = 0;
  const network = new NetworkService({ fetch: async (url, init) => {
    if (++requests === 2) return new Response("fresh");
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => {
      aborts++; reject(init.signal.reason);
    }, { once: true }));
  } });
  const controller = new AbortController();
  const pending = network.subresource("https://example.test/image", "https://example.test/page", "image", { signal: controller.signal });
  await Bun.sleep(0);
  controller.abort("document closed");
  await expect(pending).rejects.toBe("document closed");
  const fresh = await network.subresource("https://example.test/image", "https://example.test/page", "image");
  expect(new TextDecoder().decode(fresh.body)).toBe("fresh");
  expect([requests, aborts]).toEqual([2, 1]);
});

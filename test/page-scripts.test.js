import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

/**
 * Page JavaScript runs in a real renderer process (seccomp + SES lockdown),
 * because lockdown() would freeze the test runner's own realm.
 */
const scripts = new Map();
const navigations = [];
let renderer;

beforeAll(async () => {
  renderer = new RendererHost({
    timeout: 20_000,
    onNavigate: (url) => navigations.push(url),
    fetch: async (url, init = {}) => {
      const target = new URL(String(url));
      const headers = new Headers(init.headers);
      if (target.pathname === "/api/echo") {
        return new Response(JSON.stringify({
          method: init.method ?? "GET",
          cookie: headers.get("cookie"),
          contentType: headers.get("content-type"),
          origin: headers.get("origin"),
        }), { headers: [["content-type", "application/json"], ["set-cookie", "fromServer=2; Path=/"],
          ["set-cookie", "secret=3; Path=/; HttpOnly"]] });
      }
      if (target.hostname === "other.test") {
        return new Response("cross", {
          headers: target.searchParams.has("allow") ? { "access-control-allow-origin": "*" } : {},
        });
      }
      const body = scripts.get(target.href);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { headers: { "content-type": "text/javascript" } });
    },
  });
  await renderer.start();
  await renderer.call("resize", 400, 300, 1);
});

afterAll(() => renderer?.close());

// loadDocument resolves at the first paint; these tests look at the loaded page.
const load = async (html, url = "https://page.test/") => {
  await renderer.call("loadDocument", {
    url,
    source: `<!doctype html><html><head><title>t</title></head><body style="margin:0">${html}</body></html>`,
    contentType: "text/html",
    status: 200,
  });
  await renderer.call("whenLoaded");
};
const evaluate = (expression) => renderer.call("evaluate", expression);

test("the renderer reports both sandbox layers", () => {
  expect(renderer.sandbox.ses).toEqual({ installed: true, reason: null });
  expect(renderer.sandbox.seccomp.installed).toBeTrue();
});

test("classic scripts share globals, load in order and fire DOMContentLoaded then load", async () => {
  scripts.set("https://page.test/lib.js", "var fromLib = 'lib'; function libHelper() { return 'helped' }");
  await load(`
    <p id="out"></p>
    <script>var order = ['inline-1']; document.addEventListener('DOMContentLoaded', () => order.push('dcl'));
      window.addEventListener('load', () => order.push('load')); counter = 0;</script>
    <script src="lib.js"></script>
    <script>order.push('inline-2:' + fromLib + ':' + libHelper()); counter++;</script>
    <script type="module">order.push('module (deferred)')</script>
    <script nomodule>order.push('nomodule must not run')</script>
    <script type="application/ld+json">{"not": "script"}</script>`);
  expect(await evaluate("order.join(',')")).toBe("inline-1,inline-2:lib:helped,module (deferred),dcl,load");
  expect(await evaluate("counter")).toBe(1);
  expect(await evaluate("document.readyState")).toBe("complete");
});

test("scripts change the DOM and the next screenshot shows it", async () => {
  await load(`<div id="box" style="height:20px"></div>
    <script>document.getElementById('box').style.background = 'rgb(255, 0, 0)';
      document.title = 'changed by script';</script>`);
  expect(await renderer.call("title")).toBe("changed by script");
  const scripted = await renderer.call("screenshot");
  // The same box styled statically must render to identical pixels.
  await load(`<div id="box" style="height:20px;background:rgb(255, 0, 0)"></div>`);
  expect(await renderer.call("screenshot")).toBe(scripted);
  await load(`<div id="box" style="height:20px"></div>`);
  expect(await renderer.call("screenshot")).not.toBe(scripted);
});

test("fixed CSS marker stays at the same viewport position after scrolling", async () => {
  await load(`<div style="height:1000px"></div>`);
  const plain = await renderer.call("screenshot");
  await evaluate(`(() => {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;left:80px;top:90px;width:14px;height:14px;box-sizing:border-box;'
      + 'margin-left:-7px;margin-top:-7px;border:2px solid white;'
      + 'border-radius:50%;background:#f00;z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(marker);
  })()`);
  const before = await renderer.call("screenshot");
  expect(before).not.toBe(plain);
  expect(await renderer.call("scrollTo", 0, 200)).toMatchObject({ y: 200 });
  const after = await renderer.call("screenshot");
  expect(after).toBe(before);
  const bounds = await evaluate(`(() => { const r = document.documentElement.lastElementChild.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height]; })()`);
  expect(bounds).toEqual([73, 83, 14, 14]);
});

test("timers run as tasks and their DOM changes are rendered", async () => {
  await load(`<p id="p">before</p><script>setTimeout(() => { document.getElementById('p').textContent = 'after' }, 20)</script>`);
  await Bun.sleep(150);
  expect(await evaluate("document.getElementById('p').textContent")).toBe("after");
});

test("clicks reach page listeners; preventDefault cancels link navigation", async () => {
  await load(`
    <a id="kept" href="/next" style="display:block;height:40px">go</a>
    <a id="blocked" href="/blocked" style="display:block;height:40px" onclick="clicks.push('inline'); return false">stay</a>
    <script>var clicks = []; document.getElementById('kept').addEventListener('click', (event) => {
      clicks.push(event.type + ':' + event.target.id + ':' + (event.currentTarget === document.getElementById('kept')));
    });</script>`);
  expect(await renderer.call("click", 10, 10)).toBe("https://page.test/next");
  expect(await renderer.call("click", 10, 50)).toBeNull();
  expect(await evaluate("clicks.join(',')")).toBe("click:kept:true,inline");
});

test("location assignment asks the controller to navigate", async () => {
  navigations.length = 0;
  await load(`<script>setTimeout(() => { location.href = '/elsewhere?x=1' }, 0)</script>`);
  await Bun.sleep(100);
  expect(navigations).toEqual(["https://page.test/elsewhere?x=1"]);
});

test("geometry APIs read the real layout", async () => {
  await load(`<div id="box" style="width:120px;height:30px;margin-top:10px"></div>`);
  expect(await evaluate("JSON.stringify(document.getElementById('box').getBoundingClientRect())"))
    .toBe(JSON.stringify({ x: 0, y: 10, left: 0, top: 10, width: 120, height: 30, right: 120, bottom: 40 }));
  expect(await evaluate("document.getElementById('box').offsetWidth + 'x' + innerWidth")).toBe("120x400");
});

test("page scripts cannot escape the sandbox or reach engine state", async () => {
  await load(`<p id="p">x</p><script>
    var probes = {};
    const attempt = (name, fn) => { try { probes[name] = String(fn()); } catch (error) { probes[name] = 'blocked'; } };
    attempt('constructorChain', () => (function(){}).constructor('return this')().process);
    attempt('bindingConstructor', () => document.getElementById('p').constructor.constructor('return globalThis')().Bun);
    attempt('hostGlobals', () => [typeof process, typeof Bun, typeof require, typeof fetch].join('/'));
    attempt('privateState', () => Object.getOwnPropertySymbols(document).length + '/' + Object.getOwnPropertyNames(document).length);
    attempt('newBinding', () => new document.constructor());
    attempt('patchPrototype', () => { Object.getPrototypeOf(document.body).appendChild = () => 'pwned'; return 'patched'; });
    attempt('patchIntrinsic', () => { Array.prototype.includes = () => true; return 'patched'; });
    attempt('patchUrl', () => { URL.prototype.toString = () => 'pwned'; return 'patched'; });
    attempt('dynamicImport', () => eval('import("node:fs")'));
  </script>`);
  const probes = await evaluate("JSON.stringify(probes)");
  expect(JSON.parse(probes)).toEqual({
    constructorChain: "blocked",
    bindingConstructor: "blocked",
    // fetch is the page's own fetch (through the controller), not Bun's.
    hostGlobals: "undefined/undefined/undefined/function",
    privateState: "0/0",
    newBinding: "blocked",
    patchPrototype: "blocked",
    patchIntrinsic: "blocked",
    patchUrl: "blocked",
    dynamicImport: "blocked",
  });
  // Page fetch cannot read local files.
  expect(await evaluate("fetch('file:///etc/passwd').then(() => 'read', (error) => 'blocked')")).toBe("blocked");
  // The engine itself is unaffected: the page still renders and URLs still work.
  expect(await evaluate("new URL('/a', 'https://x.test').href")).toBe("https://x.test/a");
});

test("errors in one script do not stop the next", async () => {
  await load(`<script>throw new Error('first fails')</script><script>var second = 'ran'</script>`);
  expect(await evaluate("second")).toBe("ran");
  expect((await renderer.call("consoleMessages")).some((entry) => entry.text.includes("first fails"))).toBeTrue();
});

test("page-inserted scripts run; innerHTML scripts do not; on* handlers fire", async () => {
  scripts.set("https://page.test/dynamic.js", "log.push('external ran:' + (document.currentScript !== null))");
  await load(`<div id="host"></div><script>
    var log = [];
    window.onload = () => log.push('window.onload');
    const external = document.createElement('script');
    external.src = '/dynamic.js';
    external.onload = () => log.push('external onload');
    document.head.appendChild(external);
    const inline = document.createElement('script');
    inline.textContent = "log.push('inline ran during insertion')";
    document.body.append(inline);
    log.push('after inline insertion');
    document.getElementById('host').innerHTML = "<script>log.push('innerHTML must not run')<\\/script>";
    const fragment = document.createDocumentFragment();
    const inFragment = document.createElement('script');
    inFragment.textContent = "log.push('fragment script ran')";
    fragment.appendChild(inFragment);
    document.body.appendChild(fragment);
  </script>`);
  await Bun.sleep(100);
  expect(await evaluate("log.join(' | ')")).toBe([
    "inline ran during insertion",
    "after inline insertion",
    "fragment script ran",
    // A script inserted during loading delays the window load event.
    "external ran:true",
    "external onload",
    "window.onload",
  ].join(" | "));
});

test("ES modules: graphs, live exports, JSON, import.meta, dynamic import, TLA, cycles, import maps", async () => {
  const base = "https://page.test/modules/";
  scripts.set(`${base}math.js`, `
    export let counter = 0;
    export function increment() { counter++; return counter }
    export default function double(value) { return value * 2 }
    export const moduleLocal = 'm';`);
  scripts.set(`${base}barrel.js`, `export * from './math.js'; export { default as twice } from './math.js';`);
  scripts.set(`${base}data.json`, `{ "answer": 42 }`);
  scripts.set(`${base}lazy.js`, `export const lazy = 'loaded lazily from ' + import.meta.url.split('/').pop();`);
  scripts.set(`${base}a.js`, `import { b } from './b.js'; export const a = () => 'a+' + b();`);
  scripts.set(`${base}b.js`, `import { a } from './a.js'; export function b() { return 'b' } export const usesA = () => a();`);
  scripts.set("https://cdn.test/lib/index.js", `export const fromCdn = 'bare specifier via import map';`);
  scripts.set(`${base}main.js`, `
    import { counter, increment, twice } from './barrel.js';
    import * as math from './math.js';
    import data from './data.json' with { type: 'json' };
    import { a } from './a.js';
    import { usesA } from './b.js';
    import { fromCdn } from 'cdn-lib';
    increment(); increment();
    const { lazy } = await import('./lazy.js');
    window.moduleResult = [
      'named:' + counter, 'namespace:' + math.counter, 'twice:' + twice(21), 'json:' + data.answer,
      lazy, 'cycle:' + a() + '/' + usesA(), fromCdn,
      'leak:' + typeof window.moduleLocal + '/' + typeof window.increment,
    ].join(' | ');`);
  await load(`
    <script type="importmap">{ "imports": { "cdn-lib": "https://cdn.test/lib/index.js" } }</script>
    <script type="module" src="/modules/main.js"></script>
    <script type="module">window.inlineModule = import.meta.url.includes('#inline-module');</script>`);
  expect(await evaluate("moduleResult")).toBe([
    // Imports are live bindings, named and namespace alike.
    "named:2", "namespace:2", "twice:42", "json:42", "loaded lazily from lazy.js",
    "cycle:a+b/a+b", "bare specifier via import map", "leak:undefined/undefined",
  ].join(" | "));
  expect(await evaluate("inlineModule")).toBeTrue();
});

test("dynamically inserted module scripts run and fire load", async () => {
  scripts.set("https://page.test/late-module.js", "window.lateModule = 'ran as a module: ' + (this === undefined)");
  await load(`<script>
    window.events = [];
    const module = document.createElement('script');
    module.type = 'module';
    module.src = '/late-module.js';
    module.onload = () => events.push('module load');
    document.head.appendChild(module);
  </script>`);
  await Bun.sleep(100);
  expect(await evaluate("lateModule + ' / ' + events.join(',')")).toBe("ran as a module: true / module load");
});

test("fetch and XMLHttpRequest go through the controller with cookies and CORS", async () => {
  await load(`<script>
    window.network = {};
    document.cookie = 'fromPage=1; Path=/';
    (async () => {
      const echo = await (await fetch('/api/echo')).json();
      network.fetchCookie = echo.cookie;
      network.documentCookie = document.cookie;
      const form = new FormData();
      form.append('field', 'value');
      network.post = (await (await fetch('/api/echo', { method: 'POST', body: form })).json()).contentType.split(';')[0];
      network.crossBlocked = await fetch('https://other.test/data').then(() => 'allowed', (error) => error.name);
      network.crossAllowed = await (await fetch('https://other.test/data?allow')).text();
      network.xhr = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        const states = [];
        xhr.onreadystatechange = () => states.push(xhr.readyState);
        xhr.onload = () => resolve(states.join('') + ':' + xhr.status + ':' + xhr.response.method);
        xhr.responseType = 'json';
        xhr.open('GET', '/api/echo');
        xhr.send();
      });
      network.done = true;
    })();
  </script>`);
  for (let attempt = 0; attempt < 50 && !(await evaluate("network.done === true")); attempt++) await Bun.sleep(20);
  expect(JSON.parse(await evaluate("JSON.stringify(network)"))).toEqual({
    fetchCookie: "fromPage=1",
    // The server's cookie is visible to the page; its HttpOnly cookie is not.
    documentCookie: "fromPage=1; fromServer=2",
    post: "multipart/form-data",
    crossBlocked: "TypeError",
    crossAllowed: "cross",
    xhr: "1234:200:GET",
    done: true,
  });
});

test("host mode: page globals that wrap host APIs do not call themselves, and rejections are not fatal", async () => {
  const host = new RendererHost({ timeout: 20_000, args: ["--dangerously-allow-host-js"] });
  try {
    await host.start();
    await host.call("loadDocument", {
      url: "https://page.test/",
      source: `<!doctype html><title>t</title><body><script>
        Promise.reject(new Error("nobody catches this"));
        document.title = [
          typeof performance.now(), crypto.randomUUID().length, structuredClone({ a: 1 }).a, atob(btoa("ok")),
        ].join(",");
        requestAnimationFrame((time) => { document.body.dataset.frame = typeof time; });
        console.log("logged from the page");
      </script></body>`,
      contentType: "text/html",
      status: 200,
    });
    await host.call("whenLoaded");
    await Bun.sleep(100);
    expect(await host.call("title")).toBe("number,36,1,ok");
    expect(await host.call("evaluate", "document.body.dataset.frame")).toBe("number");
    const pid = host.pid;
    expect(await host.call("evaluate", "1 + 1")).toBe(2);
    expect(host.pid).toBe(pid);
  } finally {
    host.close();
  }
});

test("fragment navigation updates location, fires hashchange, and lets the page scroll", async () => {
  await load(`
    <div style="height:1000px"></div><h2 id="plain">plain</h2>
    <div style="height:1000px"></div><h2 id="custom-target">custom</h2>
    <div style="height:1000px"></div><h2><a id="user-content-readme">readme</a></h2>
    <div style="height:2000px"></div>
    <script>var changes = []; window.addEventListener('hashchange', () => {
      changes.push(location.hash + ':' + document.URL.split('#')[1]);
      if (location.hash === '#custom') document.getElementById('custom-target').scrollIntoView();
    });</script>`);
  const scrollY = () => evaluate("Math.round(scrollY)");
  const top = (id) => evaluate(`Math.round(document.getElementById('${id}').getBoundingClientRect().top + scrollY)`);

  // A plain id target is scrolled to by the browser.
  await renderer.call("showFragment", "https://page.test/#plain");
  expect(await scrollY()).toBe(await top("plain"));
  // A listener that maps the fragment scrolls itself.
  await renderer.call("showFragment", "https://page.test/#custom");
  expect(await scrollY()).toBe(await top("custom-target"));
  // No target and no script: rendered Markdown's "user-content-" id.
  await renderer.call("showFragment", "https://page.test/#readme");
  expect(await scrollY()).toBe(await top("user-content-readme"));
  // The same fragment again does not fire hashchange.
  await renderer.call("showFragment", "https://page.test/#readme");
  expect(await evaluate("changes.join(',')")).toBe("#plain:plain,#custom:custom,#readme:readme");
  expect(await evaluate("location.href")).toBe("https://page.test/#readme");
});

test("WebSocket connects through the controller: text, binary, subprotocol, Origin and close", async () => {
  const seen = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      seen.push({ origin: request.headers.get("origin"), protocol: request.headers.get("sec-websocket-protocol") });
      return server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "chat" } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(typeof message === "string" ? `echo:${message}` : message);
      },
    },
  });
  try {
    await load(`<script>
      var log = [];
      var ws = new WebSocket('ws://127.0.0.1:${server.port}/socket', ['chat']);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { log.push('open:' + ws.protocol + ':' + ws.readyState); ws.send('hi'); ws.send(new Uint8Array([1, 2, 3])); };
      ws.addEventListener('message', (event) => {
        log.push(typeof event.data === 'string' ? event.data : 'bytes:' + [...new Uint8Array(event.data)].join(','));
        if (log.length === 3) ws.close(1000, 'done');
      });
      ws.onclose = (event) => log.push('close:' + event.code + ':' + event.reason + ':' + ws.readyState);
      var bad = []; for (const u of ['ftp://x/', 'ws://x/#h']) { try { new WebSocket(u) } catch (e) { bad.push(e.name) } }
    </script>`);
    for (let i = 0; i < 50 && !String(await evaluate("log.join('|')")).includes("close"); i++) await Bun.sleep(50);
    expect(await evaluate("log.join('|')")).toBe("open:chat:1|echo:hi|bytes:1,2,3|close:1000:done:3");
    expect(await evaluate("bad.join(',')")).toBe("SyntaxError,SyntaxError");
    expect(seen).toEqual([{ origin: "https://page.test", protocol: "chat" }]);
  } finally {
    server.stop(true);
  }
});

test("an unreachable WebSocket fires error then close 1006", async () => {
  await load(`<script>var events = []; var ws = new WebSocket('ws://127.0.0.1:1/');
    ws.onerror = () => events.push('error'); ws.onclose = (e) => events.push('close:' + e.code + ':' + e.wasClean);</script>`);
  for (let i = 0; i < 50 && !String(await evaluate("events.join()")).includes("close"); i++) await Bun.sleep(50);
  expect(await evaluate("events.join()")).toBe("error,close:1006:false");
});

test("javascript: links run in the page unless a listener prevents them", async () => {
  await load(`
    <a id="run" href="javascript:ran.push(this === window, decodeURIComponent('%E4%B8%AD'), 'a%20b')" style="display:block;height:40px">run</a>
    <a id="handled" href="javascript:ran.push('must not run')" style="display:block;height:40px">handled</a>
    <script>var ran = [];
      document.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (link && link.id === 'handled') { event.preventDefault(); ran.push('listener'); }
      });</script>`);
  expect(await renderer.call("click", 10, 10)).toBeNull();
  expect(await renderer.call("click", 10, 50)).toBeNull();
  await renderer.call("runJavaScriptURL", "javascript:ran.push('typed')");
  expect(await evaluate("JSON.stringify(ran)")).toBe(JSON.stringify([true, "中", "a b", "listener", "typed"]));
  expect(await evaluate("location.href")).toBe("https://page.test/");
});

test("History.prototype can be wrapped; pushState/replaceState move location without navigating", async () => {
  navigations.length = 0;
  await load(`<script>var calls = [];
    const original = History.prototype.pushState;
    History.prototype.pushState = function (...args) { calls.push('wrapped'); return original.apply(this, args); };
    history.pushState({ page: 2 }, '', '/two?x=1');
    history.replaceState(null, '', '#frag');
    var cross = ''; try { history.pushState(null, '', 'https://elsewhere.test/') } catch (e) { cross = e.name }</script>`);
  expect(await evaluate("[calls.join(), location.href, history.state, history.length, history instanceof History, cross].join('|')"))
    .toBe("wrapped,wrapped|https://page.test/two?x=1#frag||2|true|SecurityError");
  expect(navigations).toEqual([]);
});

test("Function constructors reached through prototypes work under SES", async () => {
  await load(`<script type="module">
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const f = new AsyncFunction('a', 'b', 'return await Promise.resolve(a + b)');
    window.moduleResult = [await f(1, 2), f instanceof AsyncFunction, AsyncFunction.name];
  </script><script>
    var GeneratorFunction = (function* () {}).constructor;
    var plain = (function () {}).constructor;
    var classic = [[...new GeneratorFunction('yield 1; yield 2')()].join(), plain('return typeof window')(),
      typeof Object.getPrototypeOf(async function* () {}).constructor('yield 1')];
  </script>`);
  for (let i = 0; i < 20 && !(await evaluate("typeof moduleResult")).startsWith("object"); i++) await Bun.sleep(25);
  expect(await evaluate("JSON.stringify([moduleResult, classic])")).toBe(JSON.stringify([[3, true, "AsyncFunction"], ["1,2", "object", "function"]]));
});

test("UI event constructors, table rows/cells and select options are available", async () => {
  await load(`<table id="t"><thead><tr><th>h</th></tr></thead><tbody><tr><td>a</td><td id="b">b</td></tr></tbody></table>
    <select id="s"><option>x</option><option selected>y</option></select><div id="d"></div>
    <script>var out = [];
      const t = document.getElementById('t');
      out.push(t.rows.length, t.tBodies.length, t.rows[1].cells.length, document.getElementById('b').cellIndex, t.rows[1].rowIndex, t.tHead.tagName);
      const s = document.getElementById('s');
      out.push(s.options.length, s.selectedIndex, s.selectedOptions[0].textContent);
      s.selectedIndex = 0; out.push(s.value);
      out.push(document.getElementById('d').rows === undefined);
      const d = document.getElementById('d');
      d.addEventListener('click', (e) => out.push(e.type + ':' + e.clientX + ':' + e.shiftKey + ':' + e.defaultPrevented));
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, shiftKey: true, view: window });
      out.push(d.dispatchEvent(click) && click instanceof MouseEvent);
      const key = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
      out.push(key.key + ':' + key.code + ':' + key.repeat);</script>`);
  expect(await evaluate("JSON.stringify(out)")).toBe(JSON.stringify([2, 1, 2, 1, 1, "THEAD", 2, 1, "y", "x", true, "click:5:true:false", true, "Enter:Enter:true"]));
});

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
      if (target.pathname === "/video.mp4") return new Response(Bun.file(new URL("./fixtures/video.mp4", import.meta.url)),
        { headers: { "content-type": "video/mp4" } });
      if (target.pathname === "/tone.mp3") return new Response(Bun.file(new URL("./fixtures/tone.mp3", import.meta.url)),
        { headers: { "content-type": "audio/mpeg" } });
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

test("parser-blocking head scripts run before document.body exists", async () => {
  await load(`<head><script>window.bodyDuringHead = document.body</script></head><body><p>ready</p></body>`);
  expect(await evaluate("bodyDuringHead === null")).toBe(true);
  expect(await evaluate("document.body.textContent")).toBe("ready");
});

test("anchors expose parsed hyperlink URL components", async () => {
  await load(`<a id="link" href="/path?q=one#part"></a>`);
  expect(await evaluate(`(() => { const a = document.getElementById("link"); return [
    a.href, a.origin, a.protocol, a.host, a.hostname, a.port, a.pathname, a.search, a.hash
  ] })()`)).toEqual([
    "https://page.test/path?q=one#part", "https://page.test", "https:", "page.test", "page.test", "",
    "/path", "?q=one", "#part",
  ]);
  await evaluate(`document.getElementById("link").hostname = "other.test"`);
  expect(await evaluate(`document.getElementById("link").href`)).toBe("https://other.test/path?q=one#part");
});

test("getAttributeNode exposes a live Attr view", async () => {
  await load(`<form id="search" onsubmit="return false"></form>`);
  expect(await evaluate(`(() => { const form = document.getElementById("search"); const attr = form.getAttributeNode("onsubmit");
    const before = [attr.name, attr.value, attr.nodeType, attr.ownerElement === form, attr.specified];
    attr.value = "return true"; return [...before, form.getAttribute("onsubmit"), form.getAttributeNode("missing")]; })()`))
    .toEqual(["onsubmit", "return false", 2, true, true, "return true", null]);
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

test("clicking a text area focuses it and sends keyboard events to it", async () => {
  await load(`<textarea id="controls" style="width:180px;height:60px">Focus me</textarea><p id="result">waiting</p>
    <script>document.getElementById('controls').addEventListener('keydown', event => {
      event.preventDefault(); document.getElementById('result').textContent = event.key + (event.ctrlKey ? ':ctrl' : '');
    });</script>`);
  expect(await evaluate("document.activeElement.tagName")).toBe("BODY");
  const rect = await evaluate("document.getElementById('controls').getBoundingClientRect().toJSON() ");
  await renderer.call("click", rect.x + 10, rect.y + 10);
  expect(await evaluate("document.activeElement.id")).toBe("controls");
  await renderer.call("press", "ArrowRight");
  expect(await evaluate("document.getElementById('result').textContent")).toBe("ArrowRight");
  await renderer.call("press", "r", { code: "KeyR", modifiers: 2 });
  expect(await evaluate("document.getElementById('result').textContent")).toBe("r:ctrl");
  await evaluate("document.getElementById('controls').blur()");
  expect(await evaluate("document.activeElement.tagName")).toBe("BODY");
});

test("focused text controls accept CDP text and fire input events", async () => {
  await load(`<textarea id="editor" style="width:180px;height:60px"></textarea><p id="result"></p>
    <script>document.getElementById('editor').addEventListener('input', event => {
      document.getElementById('result').textContent = event.target.value;
    });</script>`);
  const rect = await evaluate("document.getElementById('editor').getBoundingClientRect().toJSON()");
  await renderer.call("click", rect.x + 10, rect.y + 10);
  await renderer.call("type", "hello");
  expect(await evaluate("document.getElementById('editor').value")).toBe("hello");
  expect(await evaluate("document.getElementById('result').textContent")).toBe("hello");
  await renderer.call("press", "Backspace");
  expect(await evaluate("document.getElementById('editor').value")).toBe("hell");
  await renderer.call("press", "!", { code: "Digit1", modifiers: 8 });
  expect(await evaluate("document.getElementById('editor').value")).toBe("hell!");
});

test("template content can be cloned and typed arrays are available", async () => {
  await load(`<template id="card"><span>from template</span></template><div id="mount"></div>
    <script>document.getElementById('mount').appendChild(document.getElementById('card').content.cloneNode(true));
      document.getElementById('mount').dataset.number = new Float64Array([1.5])[0];</script>`);
  expect(await evaluate("document.getElementById('mount').textContent")).toBe("from template");
  expect(await evaluate("document.getElementById('mount').dataset.number")).toBe("1.5");
});

test("DOM collection interfaces expose iterable array-compatible prototypes", async () => {
  await load(`<p>one</p><p>two</p>`);
  expect(await evaluate("typeof NodeList.prototype.forEach")).toBe("function");
  expect(await evaluate("typeof HTMLCollection.prototype.item")).toBe("undefined");
  expect(await evaluate("[...document.querySelectorAll('p')].map(p => p.textContent).join(',')")).toBe("one,two");
});

test("an unfocused page exposes an empty Selection", async () => {
  await load(`<p>text</p>`);
  expect(await evaluate("[getSelection().type, getSelection().rangeCount, getSelection().toString()].join(',')"))
    .toBe("None,0,");
});

test("page-local DOM prototypes remain writable after binding hardening", async () => {
  await load(`<button id="toggle">Toggle</button><p id="result"></p>
    <script>
      Document.prototype.customQuery = function (selector) { return this.querySelector(selector); };
      Element.prototype.customMarker = "page-local";
      document.querySelector("#toggle").addEventListener("click", () => {
        document.customQuery("#result").textContent = "clicked";
      });
      window.ready = document.querySelector("#toggle").customMarker === "page-local";
    </script>`);
  expect(await evaluate("ready")).toBe(true);
  const rect = await evaluate("document.getElementById('toggle').getBoundingClientRect().toJSON()");
  await renderer.call("click", rect.x + 1, rect.y + 1);
  expect(await evaluate("document.getElementById('result').textContent")).toBe("clicked");
  await load("<p>next document</p>");
  expect(await evaluate("Element.prototype.customMarker")).toBeUndefined();
});

test("comments expose their data like text nodes", async () => {
  // React finds its hydration boundaries by reading comment data (<!--&-->).
  await load(`<div id="host"><!--&--><!--/&--></div>`);
  expect(await evaluate("[...document.getElementById('host').childNodes].map((node) => node.data).join(' ')")).toBe("& /&");
  expect(await evaluate(`(() => {
    const comment = document.createComment("a");
    comment.data = "bc";
    return [comment.data, comment.length, comment instanceof CharacterData, comment instanceof Text, comment instanceof Comment].join(",");
  })()`)).toBe("bc,2,true,false,true");
  expect(await evaluate("document.createTextNode('xy') instanceof CharacterData")).toBe(true);
});

test("EventTarget can be constructed and subclassed", async () => {
  expect(await evaluate(`(() => {
    class Store extends EventTarget {
      constructor() { super(); this.value = 1; }
      bump() { this.value++; this.dispatchEvent(new CustomEvent("change", { detail: this.value })); }
    }
    const store = new Store();
    const seen = [];
    const listener = function (event) { seen.push([event.detail, this === store, event.target === store, event.currentTarget === store]); };
    store.addEventListener("change", listener);
    store.bump();
    store.removeEventListener("change", listener);
    store.bump();
    const plain = new EventTarget();
    let fired = 0;
    plain.addEventListener("ping", () => fired++, { once: true });
    plain.dispatchEvent(new Event("ping"));
    plain.dispatchEvent(new Event("ping"));
    return JSON.stringify({ seen, fired, value: store.value,
      checks: [store instanceof Store, store instanceof EventTarget, document.body instanceof EventTarget, window instanceof EventTarget, {} instanceof EventTarget] });
  })()`)).toBe(JSON.stringify({ seen: [[2, true, true, true]], fired: 1, value: 3, checks: [true, true, true, true, false] }));
});

test("elements attach shadow roots, and prototype patches can wrap attachShadow", async () => {
  await load(`<div id="host">light</div>`);
  expect(await evaluate(`(() => {
    // A polyfill pattern: keep the original and wrap it.
    const original = HTMLElement.prototype.attachShadow;
    let wrapped = 0;
    HTMLElement.prototype.attachShadow = function (init) { wrapped++; return original.call(this, init); };
    const host = document.getElementById("host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<span>shadow</span>";
    const closed = document.createElement("div").attachShadow({ mode: "closed" });
    return JSON.stringify({ wrapped, same: host.shadowRoot === root, host: root.host === host, mode: root.mode,
      html: root.innerHTML, shadow: root instanceof ShadowRoot, fragment: root instanceof DocumentFragment,
      closedHidden: closed.host.shadowRoot === null, light: host.textContent });
  })()`)).toBe(JSON.stringify({ wrapped: 2, same: true, host: true, mode: "open", html: "<span>shadow</span>",
    shadow: true, fragment: true, closedHidden: true, light: "light" }));
});

test("TreeWalker follows the DOM traversal algorithms with page filters", async () => {
  await load(`<div id="root"><p id="a"><b id="a1"></b>text</p><!--c--><p id="b" data-skip><i id="b1"></i></p><p id="c" data-reject><i id="c1"></i></p><p id="d"></p></div>`);
  expect(await evaluate(`(() => {
    const root = document.getElementById("root");
    const walk = (walker, step) => { const seen = []; for (let node = walker[step](); node; node = walker[step]()) seen.push(node.id || node.nodeName); return seen.join(","); };
    const elements = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => node.hasAttribute("data-reject") ? NodeFilter.FILTER_REJECT
        : node.hasAttribute("data-skip") ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
    });
    const forward = walk(elements, "nextNode");
    const backward = walk(elements, "previousNode");
    const children = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, (node) => node.hasAttribute("data-skip") ? 3 : 1);
    const first = children.firstChild().id, last = children.lastChild(), top = children.currentNode.id;
    children.currentNode = document.getElementById("a");
    const siblings = walk(children, "nextSibling");
    const everything = document.createTreeWalker(root);
    const all = walk(everything, "nextNode");
    const comments = walk(document.createTreeWalker(root, NodeFilter.SHOW_COMMENT), "nextNode");
    return [forward, backward, first, last && last.id, top, siblings, all, comments, everything.parentNode() && everything.currentNode.id].join(" | ");
  })()`)).toBe("a,a1,b1,d | b1,a1,a,root | a | a1 | a1 | b1,c,d | a,a1,#text,#comment,b,b1,c,c1,d | #comment | root");
});

test("style feature detection only finds properties the renderer implements", async () => {
  await load("<p>x</p>");
  expect(await evaluate(`["color", "backgroundColor", "setProperty", "cssText", "anchorName", "positionTryFallbacks", "notAProperty"]
    .map((name) => name in document.body.style).join(",")`)).toBe("true,true,true,true,false,false,false");
  expect(await evaluate(`[
    CSS.supports("color", "red"),
    CSS.supports("animation-timeline", "scroll()"),
    CSS.supports("(display: grid)")
  ].join(",")`)).toBe("true,false,false");
});

test("the root element's client size is the viewport, and computed style reports painting properties", async () => {
  await load(`<div id="box" style="visibility: hidden; opacity: 0.5; overflow: hidden; pointer-events: none">x</div>
    <div style="height: 5000px; width: 3000px"></div>`);
  expect(await evaluate(`[document.documentElement.clientWidth === innerWidth, document.documentElement.clientHeight === innerHeight,
    document.getElementById("box").clientWidth < 3000].join(",")`)).toBe("true,true,true");
  expect(await evaluate(`(() => { const style = getComputedStyle(document.getElementById("box"));
    return [style.visibility, style.opacity, style.overflow, style.overflowY, style.pointerEvents,
      getComputedStyle(document.body).overflow].join(","); })()`)).toBe("hidden,0.5,hidden,hidden,none,visible");
});

test("CSS.escape produces selectors for leading digits and punctuation", async () => {
  await load(`<div id="1:a"></div>`);
  expect(await evaluate("CSS.escape('1:a')")).toBe("\\31 \\:a");
});

test("a video plays frames and pauses when clicked", async () => {
  await load(`<video src="/video.mp4" controls width="160" height="120"></video>`);
  const bounds = await evaluate("document.querySelector('video').getBoundingClientRect().toJSON()");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const before = await renderer.call("screenshot");
  expect(await evaluate("document.querySelector('video').paused")).toBeTrue();
  await renderer.call("click", x, y);
  expect(await evaluate("document.querySelector('video').paused")).toBeFalse();
  const started = await renderer.call("screenshot");
  await Bun.sleep(300);
  const during = await renderer.call("screenshot");
  expect(during).not.toBe(before);
  expect(during).not.toBe(started);
  expect(await evaluate("document.querySelector('video').currentTime > 0")).toBeTrue();
  await renderer.call("click", x, y);
  expect(await evaluate("document.querySelector('video').paused")).toBeTrue();
  const paused = await renderer.call("screenshot");
  await Bun.sleep(350);
  expect(await renderer.call("screenshot")).toBe(paused);
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

test("fragment links navigate at once: later handlers see the new location, popstate fires, history grows", async () => {
  await load(`<a href="#b" style="display:block;height:40px">b</a><div style="height:900px"></div>
    <h2 id="b">b</h2><div style="height:900px"></div>
    <script>var seen = [];
      document.addEventListener('click', () => setTimeout(() => seen.push('timer ' + location.hash), 0));
      addEventListener('popstate', (event) => seen.push('popstate ' + location.hash + ' ' + event.state));
      addEventListener('hashchange', (event) => seen.push('hashchange ' + event.newURL.split('#')[1]));</script>`);
  const clicked = await renderer.call("click", 3, 10);
  expect(clicked).toEqual({ url: "https://page.test/#b", fragmentFrom: { x: 0, y: 0 } });
  await Bun.sleep(50);
  expect(await evaluate("seen.join(',')")).toBe("popstate #b null,timer #b,hashchange b");
  expect(await evaluate(`[location.hash, history.length, history.state,
    Math.round(scrollY) === Math.round(document.getElementById('b').getBoundingClientRect().top + scrollY)].join('|')`)).toBe("#b|2||true");
  // Setting location.hash is a fragment navigation too: it reads back at once.
  expect(await evaluate("(() => { location.hash = 'c'; return location.hash + ' ' + history.length })()")).toBe("#c 3");
});

test("insertAdjacentHTML keeps the order of the inserted nodes at every position", async () => {
  await load(`<div id="host"><b id="ref">ref</b></div>`);
  expect(await evaluate(`(() => {
    const ref = document.getElementById("ref");
    ref.insertAdjacentHTML("afterend", "<i>1</i><i>2</i>");
    ref.insertAdjacentHTML("beforebegin", "<u>1</u><u>2</u>");
    ref.insertAdjacentHTML("afterbegin", "<s>1</s><s>2</s>");
    ref.insertAdjacentHTML("beforeend", "<em>1</em><em>2</em>");
    return document.getElementById("host").innerHTML;
  })()`)).toBe("<u>1</u><u>2</u><b id=\"ref\"><s>1</s><s>2</s>ref<em>1</em><em>2</em></b><i>1</i><i>2</i>");
});

test("style sheets that scripts add, change or remove apply to the page", async () => {
  await load(`<p id="p">text</p><script>
    document.body.insertAdjacentHTML("afterbegin", "<style id=s>#p { display: none }</style>");
  </script>`);
  const height = () => evaluate("document.getElementById('p').getBoundingClientRect().height");
  expect(await height()).toBe(0);
  await evaluate("document.getElementById('s').textContent = '#p { padding: 10px }'");
  expect(await height()).toBeGreaterThan(20);
  await evaluate("document.getElementById('s').remove()");
  expect(await height()).toBeLessThan(25);
});

test("childNodes, children and getElementsBy* are live collections", async () => {
  await load(`<div id="host"></div>`);
  expect(await evaluate(`(() => {
    const host = document.getElementById("host");
    const source = document.createElement("div");
    source.innerHTML = "<b>1</b>text<i class=x>2</i><u class=x>3</u>";
    const nodes = source.childNodes, tags = source.getElementsByTagName("*"), named = source.getElementsByClassName("x");
    const before = [nodes.length, source.children.length, tags.length, named.length, nodes === source.childNodes];
    // Moving nodes out empties the live list, so this loop ends.
    const fragment = document.createDocumentFragment();
    let moves = 0;
    while (nodes.length && moves < 10) { fragment.appendChild(nodes[0]); moves++; }
    host.appendChild(fragment);
    return JSON.stringify({ before, moves, after: [nodes.length, tags.length, named.length],
      hostTags: Array.prototype.map.call(host.children, (element) => element.tagName).join(),
      spread: [...host.childNodes].length, item: host.childNodes.item(1).nodeType, missing: host.childNodes.item(9),
      named: host.children.namedItem("nope") });
  })()`)).toBe(JSON.stringify({ before: [4, 3, 3, 2, true], moves: 4, after: [0, 0, 0],
    hostTags: "B,I,U", spread: 4, item: 3, missing: null, named: null }));
});

test("performance.timing follows the document lifecycle", async () => {
  await load(`<script>var atParse = JSON.stringify([performance.timing.navigationStart > 0,
    performance.timing.domInteractive, performance.timing.loadEventEnd]);
    var atLoad; addEventListener("load", () => { atLoad = [performance.timing.loadEventStart > 0, performance.timing.loadEventEnd]; });</script>`);
  await Bun.sleep(50);
  expect(await evaluate("atParse")).toBe("[true,0,0]");
  expect(await evaluate(`(() => { const t = performance.timing;
    return JSON.stringify([atLoad, t.navigationStart === Math.round(performance.timeOrigin),
      t.fetchStart <= t.responseEnd && t.responseEnd <= t.domLoading && t.domLoading <= t.domInteractive
      && t.domInteractive <= t.domContentLoadedEventStart && t.domContentLoadedEventEnd <= t.domComplete
      && t.domComplete <= t.loadEventStart && t.loadEventStart <= t.loadEventEnd,
      performance.navigation.type, Object.keys(t.toJSON()).length]); })()`))
    .toBe(JSON.stringify([[true, 0], true, true, 0, 21]));
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
    attempt('dynamicImport', () => { const pending = eval('import("node:fs")'); pending.catch(() => {}); return pending instanceof Promise ? 'promise' : 'wrong'; });
  </script>`);
  const probes = await evaluate("JSON.stringify(probes)");
  expect(JSON.parse(probes)).toEqual({
    constructorChain: "blocked",
    bindingConstructor: "blocked",
    // fetch is the page's own fetch (through the controller), not Bun's.
    hostGlobals: "undefined/undefined/undefined/function",
    privateState: "0/0",
    newBinding: "blocked",
    patchPrototype: "patched",
    patchIntrinsic: "blocked",
    patchUrl: "blocked",
    dynamicImport: "promise",
  });
  await load("<p>another page</p>");
  expect(await evaluate("document.body.appendChild.toString().includes('pwned')")).toBe(false);
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
    external.onerror = () => log.push('external onerror');
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
    const blobScript = document.createElement('script');
    blobScript.src = URL.createObjectURL(new Blob(["log.push('blob script ran')"], { type: 'text/javascript' }));
    document.head.appendChild(blobScript);
  </script>`);
  await Bun.sleep(100);
  expect(await evaluate("log.join(' | ')")).toBe([
    "inline ran during insertion",
    "after inline insertion",
    "fragment script ran",
    // A script inserted during loading delays the window load event.
    "blob script ran",
    "external ran:true",
    "external onload",
    "window.onload",
  ].join(" | "));
});

test("a GET form submitted by page script navigates with its field values", async () => {
  navigations.length = 0;
  await load(`<form action="/search?old=1"><textarea name="q"></textarea><input type="hidden" name="source" value="home"></form>
    <script>document.querySelector('textarea').value = 'two words'; document.forms[0].submit()</script>`);
  expect(navigations).toEqual(["https://page.test/search?q=two+words&source=home"]);
});

test("a search textarea can be focused across its form and submitted with Enter", async () => {
  navigations.length = 0;
  await load(`<form role="search" action="/search" style="width:300px;height:50px">
    <textarea name="q" inputmode="search" style="width:100px;height:25px"></textarea>
    <input type="hidden" name="source" value="home"></form>`);
  const rect = await evaluate(`document.querySelector('form').getBoundingClientRect().toJSON()`);
  await renderer.call("click", rect.x + 200, rect.y + 15);
  expect(await evaluate("document.activeElement.tagName")).toBe("TEXTAREA");
  await renderer.call("type", "two words");
  await renderer.call("press", "Enter", { code: "Enter" });
  expect(navigations).toEqual(["https://page.test/search?q=two+words&source=home"]);

  navigations.length = 0;
  await load(`<form action="/note"><textarea name="body"></textarea></form>`);
  const plain = await evaluate(`document.querySelector('textarea').getBoundingClientRect().toJSON()`);
  await renderer.call("click", plain.x + 5, plain.y + 5);
  await renderer.call("press", "Enter", { code: "Enter" });
  expect(await evaluate("document.querySelector('textarea').value")).toBe("\n");
  expect(navigations).toEqual([]);
});

test("styles inside noscript do not apply while page scripting is enabled", async () => {
  await load(`<noscript><style>p { display: none }</style></noscript><p id="visible">visible</p>`);
  expect(await evaluate(`getComputedStyle(document.getElementById("visible")).display`)).toBe("block");
});

test("page RegExp instances can override their own toString without changing the intrinsic", async () => {
  await load(`<script>
    const pattern = /demo/;
    pattern.toString = () => "custom";
    window.regexpOverride = [pattern.toString(), (/other/).toString()];
  </script>`);
  expect(await evaluate("regexpOverride")).toEqual(["custom", "/other/"]);
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
  // The same fragment again does not fire hashchange.
  await renderer.call("showFragment", "https://page.test/#custom");
  expect(await evaluate("changes.join(',')")).toBe("#plain:plain,#custom:custom");
  expect(await evaluate("location.href")).toBe("https://page.test/#custom");
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

test("labels and unchecked checkboxes are clickable; each click toggles once, as in Chromium", async () => {
  await load(`<label id="l" style="display:block"><input type="checkbox" id="c"> Label text</label>
    <script>var changes = 0; document.getElementById('c').addEventListener('change', () => changes++);</script>`);
  const rect = async (id) => JSON.parse(await evaluate(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`));
  const box = await rect("c");
  // The unchecked box has no text; it is hit over its whole box.
  await renderer.call("click", box.left + box.width / 2, box.top + box.height / 2);
  expect(await evaluate("[document.getElementById('c').checked, changes].join()")).toBe("true,1");
  const label = await rect("l");
  await renderer.call("click", label.left + label.width - 5, label.top + label.height / 2);
  expect(await evaluate("[document.getElementById('c').checked, changes].join()")).toBe("false,2");
});

test("media elements share the HTMLMediaElement API: seek, play, pause, end, replay, events", async () => {
  await load(`<video id="v" src="/video.mp4" width="160" height="120"></video><audio id="a" controls src="/tone.mp3"></audio>
    <script>var events = [], v = document.getElementById("v"), a = document.getElementById("a");
      for (const id of ["v", "a"]) for (const type of ["loadedmetadata", "seeked", "play", "pause", "ended"]) {
        document.getElementById(id).addEventListener(type, () => events.push(id + ":" + type));
      }</script>`);
  const until = async (expression, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await evaluate(expression)) return true;
    return false;
  };
  expect(await evaluate("[v.paused, v.ended, v.currentTime, Number.isNaN(v.duration), a.paused]")).toEqual([true, false, 0, true, true]);

  await evaluate("v.currentTime = 0.5; a.currentTime = 0.4");
  expect(await until("events.includes('v:seeked') && events.includes('a:seeked')")).toBeTrue();
  expect(await evaluate("[v.duration, Math.round(v.currentTime * 10), a.duration, Math.round(a.currentTime * 10), v.paused, a.paused]"))
    .toEqual([1, 5, 1, 4, true, true]);

  await evaluate("v.play()");
  expect(await until("!v.paused && v.currentTime > 0.55")).toBeTrue();
  await evaluate("v.pause()");
  expect(await evaluate("v.paused")).toBeTrue();

  // Playing to the end, then play starts over.
  await evaluate("v.currentTime = 0.9; v.play()");
  expect(await until("v.ended && v.paused")).toBeTrue();
  await evaluate("v.play()");
  expect(await until("!v.paused && !v.ended && v.currentTime < 0.5")).toBeTrue();
  await evaluate("v.pause()");
  const seen = await evaluate("events.join()");
  for (const event of ["v:loadedmetadata", "a:loadedmetadata", "v:play", "v:pause", "v:ended"]) expect(seen).toContain(event);

  // Audio plays through a PulseAudio server on 127.0.0.1:4713 when one runs (this makes a short tone).
  if (await pulseServerRunning()) {
    await evaluate("a.currentTime = 0; a.play()");
    expect(await until("!a.paused && a.currentTime > 0.2")).toBeTrue();
    await evaluate("a.pause()");
    expect(await evaluate("a.paused")).toBeTrue();
    await evaluate("a.currentTime = 0.8; a.play()");
    expect(await until("a.ended && a.paused")).toBeTrue();
  }
});

function pulseServerRunning() {
  return new Promise((resolve) => {
    const socket = require("node:net").connect({ host: "127.0.0.1", port: 4713 });
    const done = (running) => {
      socket.destroy();
      resolve(running);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

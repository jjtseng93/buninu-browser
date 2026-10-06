import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

/**
 * Page JavaScript runs in a real renderer process (seccomp + SES lockdown),
 * because lockdown() would freeze the test runner's own realm.
 */
const scripts = new Map();
// A 2x3 red PNG.
const RED_2X3_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==",
  "base64",
);
// HTML documents (iframes), by URL.
const pages = new Map();
const navigations = [];
// Every resource request with its time, for the preload test.
const requests = [];
let renderer;
let dripFinished = false;
let dripAudioFinished = false;

beforeAll(async () => {
  renderer = new RendererHost({
    timeout: 20_000,
    onNavigate: (url) => navigations.push(url),
    fetch: async (url, init = {}) => {
      const target = new URL(String(url));
      requests.push({ url: target.href, at: performance.now() });
      if (target.pathname === "/slow.css") {
        await Bun.sleep(400);
        return new Response("body { color: red }", { headers: { "content-type": "text/css" } });
      }
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
      if (target.pathname === "/red-2x3.png") return new Response(RED_2X3_PNG, { headers: { "content-type": "image/png" } });
      // 30s: it cannot reach its end while a test clicks it, however slow the run.
      if (target.pathname === "/long-video.mp4") return new Response(Bun.file(new URL("./fixtures/long-video.mp4", import.meta.url)),
        { headers: { "content-type": "video/mp4" } });
      if (target.pathname === "/tone.mp3") return new Response(Bun.file(new URL("./fixtures/tone.mp3", import.meta.url)),
        { headers: { "content-type": "audio/mpeg" } });
      if (target.pathname === "/drip-tone.mp3") {
        const tone = new Uint8Array(await Bun.file(new URL("./fixtures/tone.mp3", import.meta.url)).bytes());
        const bytes = new Uint8Array(tone.byteLength * 8);
        for (let index = 0; index < 8; index++) bytes.set(tone, index * tone.byteLength);
        let offset = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            if (!offset) {
              controller.enqueue(bytes.subarray(0, tone.byteLength));
              offset = tone.byteLength;
              return;
            }
            await Bun.sleep(300);
            controller.enqueue(bytes.subarray(offset));
            controller.close();
            dripAudioFinished = true;
          },
        });
        return new Response(stream, { headers: { "content-type": "audio/mpeg" } });
      }
      // First 8 KiB immediately, the rest after a pause, so a test can see
      // playback begin before the body has finished.
      if (target.pathname === "/drip-video.mp4") {
        const bytes = new Uint8Array(await Bun.file(new URL("./fixtures/long-video.mp4", import.meta.url)).bytes());
        const head = bytes.subarray(0, 8192);
        const rest = bytes.subarray(8192);
        let sentHead = false;
        const stream = new ReadableStream({
          async pull(controller) {
            if (!sentHead) {
              sentHead = true;
              controller.enqueue(head);
              return;
            }
            await Bun.sleep(1500);
            controller.enqueue(rest);
            controller.close();
            dripFinished = true;
          },
        });
        return new Response(stream, { headers: { "content-type": "video/mp4" } });
      }
      // More than forty small chunks before a decodable prefix. This catches
      // arbitrary probe-attempt limits without delaying the test.
      if (target.pathname === "/many-chunk-video.mp4") {
        const bytes = new Uint8Array(await Bun.file(new URL("./fixtures/video.mp4", import.meta.url)).bytes());
        let offset = 0;
        const stream = new ReadableStream({
          pull(controller) {
            const length = offset < 128 ? 1 : bytes.byteLength - offset;
            controller.enqueue(bytes.subarray(offset, offset + length));
            offset += length;
            if (offset >= bytes.byteLength) controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "video/mp4" } });
      }
      if (target.pathname === "/invalid-video.mp4") {
        return new Response("not a media container", { headers: { "content-type": "video/mp4" } });
      }
      if (pages.has(target.href)) return new Response(pages.get(target.href), { headers: { "content-type": "text/html" } });
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

test("element.attributes is a live NamedNodeMap by index and by name", async () => {
  await load(`<img id="pic" src="a.png" alt="x">`);
  expect(await evaluate(`(() => { const img = document.getElementById("pic"); const map = img.attributes;
    const before = [map.length, map[0].name, map.src.value, map.getNamedItem("alt").value, map.item(9), map.missing === undefined,
      [...map].map((attribute) => attribute.name).join(), map === img.attributes, "src" in map];
    img.setAttribute("title", "t"); map.removeNamedItem("alt");
    return [...before, map.length, Array.from(map, (attribute) => attribute.name + "=" + attribute.value).join()]; })()`))
    .toEqual([3, "id", "a.png", "x", null, true, "id,src,alt", true, true, 3, "id=pic,src=a.png,title=t"]);
});

test("document.elementFromPoint finds the topmost element painted there", async () => {
  await load(`<div id="under" style="height:60px"><span id="text">text</span></div>
    <div id="over" style="position:absolute;top:0;left:100px;width:50px;height:50px"></div>`);
  expect(await evaluate(`[document.elementFromPoint(5, 5)?.id, document.elementFromPoint(110, 10)?.id,
    document.elementFromPoint(300, 30)?.id, document.elementFromPoint(-1, 5)]`)).toEqual(["text", "over", "under", null]);
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
  await load(`<video src="/long-video.mp4" controls width="160" height="120"></video>`);
  const bounds = await evaluate("document.querySelector('video').getBoundingClientRect().toJSON()");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const before = await renderer.call("screenshot");
  expect(await evaluate("document.querySelector('video').paused")).toBeTrue();
  await renderer.call("click", x, y);
  expect(await evaluate("document.querySelector('video').paused")).toBeFalse();
  const started = await renderer.call("screenshot");
  // A later frame, however slowly frames come under load.
  let during = started;
  for (const deadline = Date.now() + 3000; during === started && Date.now() < deadline;) {
    await Bun.sleep(100);
    during = await renderer.call("screenshot");
  }
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

test("DOM records and live form state take their distinct style invalidation paths", async () => {
  await load(`<style>
    .on .child { color: red }
    input:checked + span { display: none }
  </style>
  <div id="parent"><span class="child">child</span></div>
  <input id="box" type="checkbox"><span id="after">after</span>`);
  expect(await evaluate(`(() => {
    const parent = document.getElementById("parent");
    const child = parent.querySelector(".child");
    parent.className = "on";
    void child.offsetWidth;
    const color = getComputedStyle(child).color;
    const box = document.getElementById("box");
    box.checked = true;
    void document.getElementById("after").offsetWidth;
    return color + "/" + getComputedStyle(document.getElementById("after")).display;
  })()`)).toBe("rgba(255, 0, 0, 1)/none");
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

test("the shown document is visible", async () => {
  await load("<p>x</p>");
  expect(await evaluate("[document.visibilityState, document.hidden].join()")).toBe("visible,false");
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

test("restyles follow :has() and structural matches of inserted subtrees after later changes", async () => {
  await load(`<style>.box:has(img) { display: none } li:first-child + li span { display: none }</style>
    <div id="host"></div><ul id="list"><li>a</li></ul>`);
  // Inserted, styled, then changed inside: the inserted elements' matches
  // are what the next change is compared with.
  expect(await evaluate(`(() => {
    const host = document.getElementById("host");
    const template = document.createElement("template");
    template.innerHTML = '<div class="box" id="box"><p><img></p></div>';
    host.append(template.content); // built detached, inserted whole
    const before = getComputedStyle(document.getElementById("box")).display;
    document.querySelector("#box img").remove();
    return before + "," + getComputedStyle(document.getElementById("box")).display;
  })()`)).toBe("none,block");
  expect(await evaluate(`(() => {
    const list = document.getElementById("list");
    list.insertAdjacentHTML("beforeend", '<li><span id="s">b</span></li>');
    const before = getComputedStyle(document.getElementById("s")).display;
    list.prepend(document.createElement("li"));
    list.firstElementChild.remove();
    list.firstElementChild.remove();
    return before + "," + getComputedStyle(document.getElementById("s")).display;
  })()`)).toBe("none,inline");
});

test("styles inside noscript do not apply while page scripting is enabled", async () => {
  await load(`<noscript><style>p { display: none }</style></noscript><p id="visible">visible</p>`);
  expect(await evaluate(`getComputedStyle(document.getElementById("visible")).display`)).toBe("block");
});

test("pages can wrap Promise methods without modifying another realm", async () => {
  await load(`<script>
    window.promiseCalls = 0;
    const original = Promise.prototype.then;
    Promise.prototype.then = function (...args) { promiseCalls++; return original.apply(this, args); };
    Promise.prototype.catch = function (reject) { return this.then(undefined, reject); };
    Promise.prototype.finally = function (done) { return this.then(value => { done(); return value; }); };
    window.promiseResult = null;
    Promise.resolve(42).finally(() => {}).then(value => { promiseResult = value; });
  </script>`);
  await waitFor("promiseResult === 42");
  expect(await evaluate("promiseCalls")).toBeGreaterThanOrEqual(2);
  expect(await evaluate("Promise.resolve(0) instanceof Promise")).toBe(true);
  expect(await evaluate("(async () => 1)() instanceof Promise")).toBe(true);
  expect(await evaluate("(() => { class Child extends Promise {} return [new Child(r => r()) instanceof Child, Promise.resolve() instanceof Child]; })()")).toEqual([true, false]);
  await load(`<script>window.promiseResult = null; Promise.all([Promise.resolve(7)]).then(v => promiseResult = v[0]);</script>`);
  await waitFor("promiseResult === 7");
  expect(await evaluate("typeof promiseCalls")).toBe("undefined");
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

test("scripts and module preloads are fetched while the stylesheets load, each once", async () => {
  const base = "https://page.test/preload/";
  scripts.set(`${base}main.js`, "import { value } from './dep.js'; window.preloaded = value;");
  scripts.set(`${base}dep.js`, "export const value = 'dep';");
  scripts.set(`${base}classic.js`, "window.classic = 'ran';");
  scripts.set(`${base}skipped.js`, "window.skipped = 'ran';");
  requests.length = 0;
  const started = performance.now();
  await load(`<link rel="stylesheet" href="/slow.css"><link rel="modulepreload" href="/preload/dep.js">
    <script type="module" src="/preload/main.js"></script><script src="/preload/classic.js"></script>
    <script nomodule src="/preload/skipped.js"></script>`);
  expect(await evaluate("[window.preloaded, window.classic, window.skipped].join()")).toBe("dep,ran,");
  const times = (path) => requests.filter((request) => request.url === `https://page.test${path}`).map((request) => request.at - started);
  // Requested before the 400 ms stylesheet arrived, not after it.
  for (const path of ["/preload/main.js", "/preload/dep.js", "/preload/classic.js"]) {
    expect(times(path).length).toBe(1);
    expect(times(path)[0]).toBeLessThan(times("/slow.css")[0] + 300);
  }
  expect(times("/preload/skipped.js")).toEqual([]);
});


test("an error status shows the page the server sent, scripts included; an empty one gets a note", async () => {
  await renderer.call("loadDocument", {
    url: "https://page.test/limited",
    source: `<!doctype html><title>check</title><body><form id="f"><p>unusual traffic</p></form><script>document.title = "ran";</script></body>`,
    contentType: "text/html",
    status: 429,
    statusText: "Too Many Requests",
  });
  await renderer.call("whenLoaded");
  expect(await evaluate("[document.title, !!document.getElementById('f'), document.body.innerText.includes('HTTP 429')].join()"))
    .toBe("ran,true,false");
  await renderer.call("loadDocument", { url: "https://page.test/gone", source: "", contentType: "text/html", status: 404, statusText: "Not Found" });
  await renderer.call("whenLoaded");
  expect(await evaluate("document.body.textContent")).toBe("HTTP 404 Not Found");
});

test("meta.content is the reflected attribute; template.content stays the fragment", async () => {
  await load(`<template id="t"><b>x</b></template><script>
    "use strict";
    const meta = document.createElement("meta");
    meta.httpEquiv = "origin-trial";
    meta.content = "token";
    const other = document.createElement("div");
    other.content = 5;
    window.metaResult = [meta.getAttribute("content"), meta.content, other.content,
      document.getElementById("t").content.firstChild.nodeName].join();
  </script>`);
  expect(await evaluate("metaResult")).toBe("token,token,5,B");
});

test("a video starts from a prefix while the rest of the file is still downloading", async () => {
  dripFinished = false;
  await load(`<video id="v" src="/drip-video.mp4" width="160" height="120"></video>`);
  await evaluate("document.getElementById('v').play()");
  expect(dripFinished).toBe(false);
  expect(await evaluate(`(() => { const v = document.getElementById('v');
    return !v.paused && v.readyState >= 1 && v.currentTime > 0 && v.networkState === 2; })()`)).toBe(true);
  const deadline = Date.now() + 4000;
  while (!dripFinished && Date.now() < deadline) await Bun.sleep(50);
  expect(dripFinished).toBe(true);
});

test("a video probe is not limited by the number of network chunks", async () => {
  await load(`<video id="v" src="/many-chunk-video.mp4" width="160" height="120"></video>`);
  await evaluate("document.getElementById('v').play()");
  expect(await waitFor(`(() => { const v = document.getElementById('v');
    return !v.paused && v.error === null && v.readyState >= 1 && v.currentTime > 0; })()`)).toBe(true);
});

test("a progressive MP3 updates its duration when the rest of the body arrives", async () => {
  dripAudioFinished = false;
  await load(`<audio id="a" src="/drip-tone.mp3"></audio>`);
  await evaluate("document.getElementById('a').play()");
  const initial = await evaluate("document.getElementById('a').duration");
  expect(dripAudioFinished).toBe(false);
  expect(await waitFor("document.getElementById('a').duration > " + initial, 3000)).toBe(true);
  expect(dripAudioFinished).toBe(true);
});

test("an unsupported video exposes an error instead of silently stopping", async () => {
  await load(`<video id="v" src="/invalid-video.mp4"></video>`);
  await evaluate(`(() => { const v = document.getElementById("v");
    window.mediaFailed = false;
    v.addEventListener("error", () => { window.mediaFailed = true; });
    v.play();
  })()`);
  expect(await waitFor("window.mediaFailed === true")).toBe(true);
  expect(await evaluate(`(() => { const v = document.getElementById("v");
    return v.paused && v.error?.code === 4 && v.networkState === 3; })()`)).toBe(true);
});

test("MediaSource appends a file in parts and the element can play it", async () => {
  await load(`<video id="v" width="160" height="120"></video>`);
  expect(await evaluate(`(() => {
    try {
      new MediaSource().addSourceBuffer('video/mp4; codecs="avc1.4d401e"');
      return "no-throw";
    } catch (error) {
      return error.name;
    }
  })()`)).toBe("InvalidStateError");
  expect(await evaluate(`[
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e"'),
    MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e, mp4a.40.2"'),
    MediaSource.isTypeSupported("video/mp4"),
    MediaSource.isTypeSupported("video/x-unknown"),
    HTMLMediaElement.HAVE_METADATA,
    HTMLMediaElement.HAVE_NOTHING
  ].join()`)).toBe("true,true,true,false,false,1,0");
  await evaluate(`(() => {
    const video = document.getElementById("v");
    const source = new MediaSource();
    window.ms = source;
    window.mse = {};
    video.src = URL.createObjectURL(source);
    source.addEventListener("sourceopen", () => { window.mse.open = source.readyState; });
  })()`);
  await waitFor("window.mse.open === 'open'");
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await (await fetch("/video.mp4")).arrayBuffer());
    const buffer = window.ms.addSourceBuffer('video/mp4; codecs="avc1.4d401e, mp4a.40.2"');
    const middle = bytes.length >> 1;
    let updates = 0;
    buffer.appendBuffer(bytes.subarray(0, middle));
    buffer.addEventListener("updateend", () => {
      updates += 1;
      window.mse.updates = updates;
      window.mse.ready = document.getElementById("v").readyState;
      if (updates === 1) {
        document.getElementById("v").play();
        buffer.appendBuffer(bytes.subarray(middle));
      } else {
        window.mse.buffered = buffer.buffered.length ? buffer.buffered.end(0) : 0;
        window.ms.endOfStream();
        window.mse.ended = window.ms.readyState;
      }
    });
  })()`);
  await waitFor("window.mse.updates === 2 && window.mse.ended === 'ended'");
  expect(await waitFor("document.getElementById('v').readyState >= 1")).toBe(true);
  expect(await evaluate("window.mse.buffered > 0")).toBe(true);
  expect(await waitFor("(() => { const v = document.getElementById('v'); return !v.paused && v.currentTime > 0; })()")).toBe(true);
  expect(await evaluate("Math.round(document.getElementById('v').duration)")).toBe(1);
});

test("MediaSource consumes an append that arrived before the decoder stalled", async () => {
  await load(`<video id="v" width="160" height="120"></video>`);
  await evaluate(`(() => {
    const video = document.getElementById("v");
    const source = new MediaSource();
    window.ms = source;
    video.src = URL.createObjectURL(source);
    source.addEventListener("sourceopen", async () => {
      const bytes = new Uint8Array(await (await fetch("/video.mp4")).arrayBuffer());
      const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.4d401e, mp4a.40.2"');
      const middle = bytes.length >> 1;
      let append = 0;
      buffer.addEventListener("updateend", () => {
        append += 1;
        if (append === 1) {
          video.play();
          buffer.appendBuffer(bytes.subarray(middle));
        }
      });
      buffer.appendBuffer(bytes.subarray(0, middle));
    });
  })()`);
  // Deliberately leave the MediaSource open. Playback must reopen from the
  // already-appended second generation rather than wait for a third append.
  expect(await waitFor("document.getElementById('v').currentTime > 0.75", 4000)).toBe(true);
});

test("a video plays while its audio SourceBuffer is not decodable yet", async () => {
  await load(`<video id="v" width="160" height="120"></video>`);
  await evaluate(`(() => {
    const video = document.getElementById("v");
    const source = new MediaSource();
    window.ms = source;
    window.mse = {};
    video.src = URL.createObjectURL(source);
    source.addEventListener("sourceopen", () => { window.mse.open = source.readyState; });
  })()`);
  await waitFor("window.mse.open === 'open'");
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await (await fetch("/video.mp4")).arrayBuffer());
    const picture = window.ms.addSourceBuffer('video/mp4; codecs="avc1.4d401e"');
    const sound = window.ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    picture.addEventListener("updateend", () => {
      window.mse.videoUpdated = true;
      document.getElementById("v").play();
    });
    picture.appendBuffer(bytes);
    sound.appendBuffer(bytes.subarray(0, 32));
  })()`);
  await waitFor("window.mse.videoUpdated === true");
  expect(await waitFor(`(() => { const v = document.getElementById('v');
    return !v.paused && v.error === null && v.currentTime > 0 && v.videoWidth > 0; })()`)).toBe(true);
});

test("initial MSE playback waits briefly for a separate audio segment", async () => {
  await load(`<video id="v" width="160" height="120"></video>`);
  await evaluate(`(() => {
    const video = document.getElementById("v");
    video.addEventListener("play", () => { window.startedAt = performance.now(); });
    const source = new MediaSource();
    video.src = URL.createObjectURL(source);
    source.addEventListener("sourceopen", async () => {
      const bytes = new Uint8Array(await (await fetch("/video.mp4")).arrayBuffer());
      const picture = source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"');
      const sound = source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
      picture.addEventListener("updateend", () => video.play(), { once: true });
      picture.appendBuffer(bytes);
      sound.appendBuffer(bytes.subarray(0, 16));
      setTimeout(() => {
        window.audioAppendedAt = performance.now();
        sound.appendBuffer(bytes.subarray(16));
      }, 250);
    });
  })()`);
  expect(await waitFor("Boolean(window.startedAt && window.audioAppendedAt)", 3000)).toBe(true);
  expect(await evaluate("window.startedAt >= window.audioAppendedAt")).toBe(true);
  expect(await waitFor("document.getElementById('v').currentTime > 0.1", 3000)).toBe(true);
});

const waitFor = async (expression, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${expression}`);
};

test("same-origin iframes: documents, contentWindow, names, postMessage with source and origin", async () => {
  pages.set("https://page.test/child.html", `<!doctype html><body><p id="inner">child</p><script>
    window.addEventListener("message", (event) => {
      event.source.postMessage({ echo: event.data, fromParent: event.source === parent, origin: event.origin }, "*");
    });
  </script></body>`);
  await load(`<iframe id="frame" name="kid" src="child.html" style="width:200px;height:100px"></iframe><script>
    window.replies = [];
    window.addEventListener("message", (event) => replies.push({ data: event.data, fromChild: event.source === frames.kid,
      origin: event.origin }));
    document.getElementById("frame").addEventListener("load", () => {
      window.frameLoaded = true;
      frames.kid.postMessage("hello", "https://page.test");
      frames.kid.postMessage("never", "https://other.test");
    });
  </script>`);
  await waitFor("window.replies.length > 0");
  expect(await evaluate("frames.length")).toBe(1);
  expect(await evaluate(`document.getElementById("frame").contentDocument.getElementById("inner").textContent`)).toBe("child");
  expect(await evaluate(`document.getElementById("frame").contentWindow.parent === window`)).toBe(true);
  await Bun.sleep(100);
  // The message for another origin is not delivered.
  expect(await evaluate("replies")).toEqual([{
    data: { echo: "hello", fromParent: true, origin: "https://page.test" }, fromChild: true, origin: "https://page.test",
  }]);
});

test("iframe messages retain their sender through promises and await", async () => {
  pages.set("https://page.test/async-child.html", `<!doctype html><script>
    addEventListener("message", async (event) => {
      window.fromParent = event.source === parent;
      await Promise.resolve();
      parent.postMessage("await reply", "*");
      Promise.resolve().then(() => parent.postMessage("then reply", "*"));
    });
  </script>`);
  await load(`<iframe id="frame" src="async-child.html"></iframe><script>
    window.asyncReplies = [];
    addEventListener("message", event => asyncReplies.push({
      data: event.data, fromChild: event.source === document.getElementById("frame").contentWindow,
      origin: event.origin
    }));
    document.getElementById("frame").addEventListener("load", async () => {
      await Promise.resolve();
      document.getElementById("frame").contentWindow.postMessage("start", "*");
    });
  </script>`);
  await waitFor("window.asyncReplies.length === 2");
  expect(await evaluate("asyncReplies")).toEqual([
    { data: "await reply", fromChild: true, origin: "https://page.test" },
    { data: "then reply", fromChild: true, origin: "https://page.test" },
  ]);
  expect(await evaluate('document.getElementById("frame").contentWindow.fromParent')).toBe(true);
});

test("an inserted iframe has its about:blank window at once and fires load once", async () => {
  await load(`<p>blank</p><script>
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    window.result = [win.JSON.parse('{"a":1}').a, !!win.document.body, frame.contentDocument === win.document];
    window.loads = 0;
    frame.addEventListener("load", () => { loads++; window.sameWindow = frame.contentWindow === win; });
  </script>`);
  expect(await evaluate("result")).toEqual([1, true, true]);
  await waitFor("window.loads > 0");
  await Bun.sleep(100);
  expect(await evaluate("[loads, sameWindow]")).toEqual([1, true]);
});

test("MessageChannel ports and dedicated workers with importScripts and transfers", async () => {
  scripts.set("https://page.test/helper.js", "self.double = (n) => n * 2;");
  scripts.set("https://page.test/worker.js", `importScripts("helper.js");
    onmessage = (event) => {
      const [port] = event.ports;
      port.postMessage({ doubled: double(event.data.n), bytes: event.data.buffer.byteLength });
    };`);
  await load(`<script>
    window.got = null;
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => { window.got = event.data; };
    const worker = new Worker("worker.js");
    const buffer = new ArrayBuffer(8);
    worker.postMessage({ n: 21, buffer }, [channel.port2, buffer]);
    window.detached = buffer.byteLength;
  </script>`);
  await waitFor("window.got");
  expect(await evaluate("[got, detached]")).toEqual([{ doubled: 42, bytes: 8 }, 0]);
});

test("sloppy-mode this is the global object, also through the Function constructor", async () => {
  await load(`<script>
    window.viaFunction = Function("return this")() === window;
    window.viaCall = (function () { return this; })() === window;
    window.strict = (function () { "use strict"; return this; })() === undefined;
  </script>`);
  expect(await evaluate("[viaFunction, viaCall, strict]")).toEqual([true, true, true]);
});

test("a click sends pointer and mouse events to the element under it, then focuses its focusable ancestor", async () => {
  await load(`<div id="tile" tabindex="0" style="width:100px;height:60px"><span id="label">tile</span></div><script>
    window.events = [];
    for (const type of ["pointerdown", "mousedown", "focus", "pointerup", "mouseup", "click"]) {
      document.getElementById("tile").addEventListener(type, (event) => events.push(type + ":" + event.target.id), true);
    }
  </script>`);
  await renderer.call("click", 80, 30);
  expect(await evaluate("events")).toEqual(["pointerdown:tile", "mousedown:tile", "focus:tile", "pointerup:tile", "mouseup:tile", "click:tile"]);
  expect(await evaluate("document.activeElement.id")).toBe("tile");
});

test("a click inside an iframe goes to the element under it in the frame's document", async () => {
  pages.set("https://page.test/cells.html", `<!doctype html><body style="margin:0"><div id="cell" style="width:100px;height:100px"></div><script>
    window.clicked = [];
    document.getElementById("cell").addEventListener("click", (event) => clicked.push([event.clientX, event.clientY]));
  </script></body>`);
  await load(`<iframe id="frame" src="cells.html" style="position:absolute;left:50px;top:40px;width:200px;height:150px;border:0"></iframe>`);
  await waitFor(`document.getElementById("frame").contentWindow.clicked`);
  await renderer.call("click", 70, 60);
  expect(await evaluate(`document.getElementById("frame").contentWindow.clicked`)).toEqual([[20, 20]]);
});

test("images a script inserts and measures at once still load", async () => {
  await load(`<div id="host"></div><script>
    const img = document.createElement("img");
    img.src = "/red-2x3.png";
    document.getElementById("host").appendChild(img);
    // Reading geometry lays the page out before any frame does.
    window.firstWidth = img.getBoundingClientRect().width;
  </script>`);
  await waitFor(`document.querySelector("img").getBoundingClientRect().width === 2`);
  expect(await evaluate(`[document.querySelector("img").getBoundingClientRect().height, firstWidth !== 2]`)).toEqual([3, true]);
});

test("scroll containers scroll by wheel and script, move their content and hit-test where it shows", async () => {
  await load(`<div id="box" style="width:200px;height:100px;overflow-y:auto;border:2px solid black">${
    Array.from({ length: 10 }, (_, index) => `<p id="p${index}" style="margin:0;height:30px" onclick="window.hit = this.id">row ${index}</p>`).join("")
  }</div><div id="still" style="height:40px;overflow:hidden"><p style="margin:0;height:80px">hidden overflow</p></div><script>
    window.$ = (id) => document.getElementById(id);
    window.scrolls = 0;
    $("box").addEventListener("scroll", () => scrolls++);
  </script>`);
  expect(await evaluate(`[$("box").scrollTop, $("box").scrollHeight, $("box").clientHeight, $("p3").getBoundingClientRect().top]`))
    .toEqual([0, 300, 100, 92]);
  // The wheel over the container scrolls it, not the page: nothing is left over.
  expect(await renderer.call("wheel", 50, 50, 0, 75)).toEqual({ x: 0, y: 0 });
  await waitFor("window.scrolls > 0");
  expect(await evaluate(`[$("box").scrollTop, $("p3").getBoundingClientRect().top]`)).toEqual([75, 17]);
  await renderer.call("click", 50, 20);
  expect(await evaluate("window.hit")).toBe("p3");
  // Scripts scroll it too, clamped; overflow: hidden scrolls only by script.
  expect(await evaluate(`($("box").scrollTop = 1000, $("box").scrollTop)`)).toBe(200);
  expect(await evaluate(`$("p1").scrollIntoView(), [$("box").scrollTop, $("p1").getBoundingClientRect().top]`)).toEqual([30, 2]);
  const still = await evaluate(`$("still").getBoundingClientRect().toJSON()`);
  expect(await renderer.call("wheel", 50, still.y + 10, 0, 20)).toEqual({ x: 0, y: 20 });
  expect(await evaluate(`($("still").scrollTop = 25, $("still").scrollTop)`)).toBe(25);
  // What the container cannot take goes on to the page (scroll chaining).
  await evaluate(`$("box").scrollTop = 190`);
  expect(await renderer.call("wheel", 50, 50, 0, 30)).toEqual({ x: 0, y: 20 });
  expect(await evaluate(`$("box").scrollTop`)).toBe(200);
  // A wheel listener that cancels the event keeps it where it is.
  await evaluate(`$("box").scrollTop = 30; $("box").addEventListener("wheel", (event) => event.preventDefault())`);
  expect(await renderer.call("wheel", 50, 50, 0, 30)).toEqual({ x: 0, y: 0 });
  expect(await evaluate(`$("box").scrollTop`)).toBe(30);
});

test("the wheel over an iframe scrolls its document first, unless scrolling=no, then what is around it", async () => {
  pages.set("https://page.test/tall.html", `<!doctype html><body style="margin:0"><div style="height:400px">tall</div></body>`);
  await load(`<div id="outer" style="width:220px;height:100px;overflow:auto">
    <iframe id="fixed" scrolling="no" src="tall.html" style="display:block;width:200px;height:150px;border:0"></iframe>
    <iframe id="free" src="tall.html" style="display:block;width:200px;height:150px;border:0"></iframe>
  </div><script>window.$ = (id) => document.getElementById(id);</script>`);
  await waitFor(`$("free").contentDocument?.body?.textContent === "tall" && $("fixed").contentDocument?.body?.textContent === "tall"`);
  // Over the scrolling=no frame: its document stays, the container scrolls.
  expect(await renderer.call("wheel", 50, 20, 0, 60)).toEqual({ x: 0, y: 0 });
  expect(await evaluate(`[$("outer").scrollTop, $("fixed").contentWindow.scrollY]`)).toEqual([60, 0]);
  // Over the other frame (now at 90..240): its document scrolls first.
  expect(await renderer.call("wheel", 50, 95, 0, 30)).toEqual({ x: 0, y: 0 });
  expect(await evaluate(`[$("outer").scrollTop, $("free").contentWindow.scrollY]`)).toEqual([60, 30]);
});

test("compareDocumentPosition, document.styleSheets and user timing with PerformanceObserver", async () => {
  await load(`<style>p { color: red }</style><link rel="stylesheet" href="/missing.css" media="print">
    <div id="outer"><p id="first">a</p><p id="second">b</p></div><script>
    window.$ = (id) => document.getElementById(id);
    window.observed = [];
    new PerformanceObserver((list) => observed.push(...list.getEntries().map((entry) => entry.entryType + ":" + entry.name)))
      .observe({ entryTypes: ["mark", "measure"] });
    performance.mark("start");
    performance.mark("end");
    performance.measure("span", "start", "end");
  </script>`);
  expect(await evaluate(`[
    $("first").compareDocumentPosition($("second")), $("second").compareDocumentPosition($("first")),
    $("outer").compareDocumentPosition($("first")), $("first").compareDocumentPosition($("outer")),
    Node.DOCUMENT_POSITION_FOLLOWING, $("first").DOCUMENT_POSITION_CONTAINED_BY,
  ]`)).toEqual([4, 2, 20, 10, 4, 16]);
  expect(await evaluate(`[document.styleSheets.length, document.styleSheets[0].href, document.styleSheets[1].href,
    document.styleSheets.item(1).media.mediaText, document.styleSheets[0].ownerNode.tagName]`))
    .toEqual([2, null, "https://page.test/missing.css", "print", "STYLE"]);
  await waitFor("window.observed.length === 3");
  expect(await evaluate(`[observed, performance.getEntriesByType("measure").length, PerformanceObserver.supportedEntryTypes]`))
    .toEqual([["mark:start", "mark:end", "measure:span"], 1, ["mark", "measure"]]);
  expect(await evaluate(`performance.clearMarks(), performance.clearMeasures("span"), performance.getEntries().length`)).toBe(0);
});

test("selectors with CSS escapes parse, in type selectors and around combinators too", async () => {
  await load(`<div id="a:b" class="x,y 1x"><span class="p(q)" data-k='a"b'>1</span><p id="123">2</p></div><my-el>3</my-el>`);
  const selectors = [String.raw`style\=\"\"`, String.raw`#a\:b`, String.raw`.x\,y > span`, String.raw`.p\(q\)`,
    String.raw`my\-el`, String.raw`\64 iv`,
    // CSS.escape() output for names starting with a digit, and an escaped quote in a value.
    String.raw`#\31 23`, String.raw`.\31 x p`, String.raw`[data-k="a\"b"]`, String.raw`[d\61 ta-k]`];
  expect(await evaluate(`${JSON.stringify(selectors)}.map((selector) => document.querySelectorAll(selector).length)`))
    .toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test("a canvas 2d context samples colours through CanvasKit", async () => {
  await load("");
  expect(await evaluate(`(() => {
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const sample = (color) => {
      context.fillStyle = "#000";
      context.fillStyle = color;
      const first = context.fillStyle;
      context.fillStyle = "#fff";
      context.fillStyle = color;
      if (first !== context.fillStyle) return null;
      context.fillRect(0, 0, 1, 1);
      const data = [...context.getImageData(0, 0, 1, 1).data];
      context.clearRect(0, 0, 1, 1);
      return data;
    };
    return {
      onDiv: "getContext" in document.createElement("div"),
      same: canvas.getContext("2d") === context,
      webgl: canvas.getContext("webgl"),
      size: [document.createElement("canvas").width, document.createElement("canvas").height],
      red: sample("red"),
      bad: sample("not-a-color"),
    };
  })()`)).toEqual({
    onDiv: false, same: true, webgl: null, size: [300, 150], red: [255, 0, 0, 255], bad: [0, 0, 0, 255],
  });
});

test("the page scrolls over content that overflows a 100vh layout, not over clipped or fixed content", async () => {
  await load(`<div style="height:100vh;display:flex;flex-direction:column">
      <header style="height:50px">top</header><main style="height:2000px;flex-shrink:0">tall</main>
      <footer id="end" style="height:40px;flex-shrink:0">end</footer></div>
    <div style="height:20px;overflow:hidden"><div style="height:9000px">clipped</div></div>
    <div style="position:fixed;top:0;height:20000px;width:10px"></div>`);
  // 50 + 2000 + 40 of overflowing content: the footer can be scrolled to; clipped and fixed boxes add nothing.
  expect(await evaluate(`(scrollTo(0, 99999), [scrollY, Math.round(document.getElementById("end").getBoundingClientRect().bottom)])`))
    .toEqual([2090 - 300, 300]);
});

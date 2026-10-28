import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { createResourceElements } from "../lib/renderer/resource-elements.js";

async function fixture(run) {
  const { window, document } = parseHTMLDocument(`<!doctype html><head>
    <style>body {color:red}</style><link rel="preload" href="one.css"></head>
    <body><img src="one.png"><video></video><iframe></iframe></body>`, "https://resource.test/");
  const query = document.querySelectorAll.bind(document), queries = [];
  document.querySelectorAll = selector => { queries.push(selector); return query(selector); };
  const cache = createResourceElements(document);
  try { await run({ window, document, cache, queries }); }
  finally { cache.dispose(); await window.happyDOM.close(); }
}

test("metadata changes retain discovery while resource attributes and sheet text remain live", async () => {
  await fixture(async ({ document, cache, queries }) => {
    const before = Object.fromEntries(["media", "images", "sheets", "frames"].map(kind => [kind, cache.get(kind)]));
    const [image] = before.images, [style] = before.sheets;
    queries.length = 0;
    for (let i = 0; i < 20; i++) {
      document.body.setAttribute("data-counter", String(i));
      image.setAttribute("aria-label", String(i));
      image.setAttribute("class", `item-${i}`);
      for (const kind of Object.keys(before)) expect(cache.get(kind)).toBe(before[kind]);
    }
    image.setAttribute("src", "two.png");
    image.setAttribute("crossorigin", "anonymous");
    style.setAttribute("media", "print");
    style.setAttribute("type", "text/plain");
    style.firstChild.data = "body {color:blue}";
    expect(cache.get("images")[0].getAttribute("src")).toBe("two.png");
    expect(cache.get("images")[0].getAttribute("crossorigin")).toBe("anonymous");
    expect(cache.get("sheets")[0].textContent).toBe("body {color:blue}");
    expect(cache.get("sheets")[0].getAttribute("media")).toBe("print");
    expect(cache.get("sheets")[0].getAttribute("type")).toBe("text/plain");
    expect(queries).toEqual([]);
  });
});

test("rel membership is refreshed synchronously without rescanning other resource kinds", async () => {
  await fixture(async ({ document, cache, queries }) => {
    const imageList = cache.get("images"), sheets = cache.get("sheets");
    const link = document.getElementsByTagName("link")[0];
    queries.length = 0;
    link.setAttribute("rel", "alternate stylesheet");
    expect(cache.get("sheets")).toEqual([sheets[0], link]);
    expect(cache.get("images")).toBe(imageList);
    link.setAttribute("href", "two.css");
    link.setAttribute("disabled", "");
    expect(cache.get("sheets")[1].getAttribute("href")).toBe("two.css");
    expect(cache.get("sheets")[1].hasAttribute("disabled")).toBe(true);
    link.removeAttribute("rel");
    expect(cache.get("sheets")).toEqual(sheets);
    expect(queries).toEqual(["style, link[rel~='stylesheet']", "style, link[rel~='stylesheet']"]);
  });
});

test("text and comment replacement preserves element discovery but stylesheet contents stay live", async () => {
  await fixture(async ({ document, cache, queries }) => {
    const counter = document.createElement("span");
    document.body.append(counter);
    const kinds = ["media", "images", "sheets", "frames"];
    const lists = Object.fromEntries(kinds.map(kind => [kind, cache.get(kind)]));
    const style = lists.sheets[0];
    queries.length = 0;
    for (let index = 0; index < 20; index++) {
      counter.textContent = String(index);
      const comment = document.createComment("counter");
      counter.append(comment);
      comment.remove();
      style.textContent = `body { z-index: ${index} }`;
      for (const kind of kinds) expect(cache.get(kind)).toBe(lists[kind]);
      expect(cache.get("sheets")[0].textContent).toBe(`body { z-index: ${index} }`);
    }
    counter.textContent = "after delivery";
    await Bun.sleep(10);
    for (const kind of kinds) expect(cache.get(kind)).toBe(lists[kind]);
    expect(queries).toEqual([]);
    // An element removed through textContent still invalidates membership.
    counter.append(lists.images[0]);
    cache.get("images");
    counter.textContent = "removed image";
    expect(cache.get("images")).toEqual([]);
  });
});

test("insert, remove and reattach are discovered before and after observer delivery", async () => {
  await fixture(async ({ document, cache }) => {
    const old = cache.get("images")[0];
    const subtree = document.createElement("section");
    subtree.innerHTML = '<img src="new.png"><audio></audio><style>p{color:red}</style><iframe></iframe>';
    document.body.append(subtree);
    expect(cache.get("images")).toEqual([old, subtree.firstChild]);
    expect(cache.get("media").map(element => element.tagName)).toEqual(["VIDEO", "AUDIO"]);
    expect(cache.get("frames")).toHaveLength(2);
    expect(cache.get("sheets")).toHaveLength(2);
    subtree.remove();
    expect(cache.get("images")).toEqual([old]);
    document.body.append(subtree);
    await Bun.sleep(10); // exercise the observer callback, not just takeRecords()
    expect(cache.get("frames")).toHaveLength(2);
    old.remove();
    expect(cache.get("images")).toEqual([subtree.firstChild]);
    document.body.append(old);
    expect(cache.get("images")).toEqual([subtree.firstChild, old]);
  });
});

test("navigation/disposal releases old discovery and base URLs are read from live elements", async () => {
  await fixture(async ({ document, cache }) => {
    const image = cache.get("images")[0];
    const base = document.createElement("base");
    base.setAttribute("href", "/first/"); document.head.prepend(base);
    expect(cache.get("images")[0]).toBe(image);
    expect(new URL(image.getAttribute("src"), image.baseURI).href).toBe("https://resource.test/first/one.png");
    base.setAttribute("href", "/second/");
    expect(new URL(cache.get("images")[0].getAttribute("src"), image.baseURI).href).toBe("https://resource.test/second/one.png");
    cache.dispose();
    expect(() => cache.get("images")).toThrow("disposed");
    const fresh = createResourceElements(document);
    try {
      image.remove();
      expect(fresh.get("images")).toEqual([]);
    } finally { fresh.dispose(); }
  });
});

test("ordinary subtree edits retain resource lists and image edits only rescan images", async () => {
  for (const delivered of [false, true]) await fixture(async ({ document, cache, queries }) => {
    const container = document.createElement("div");
    document.body.append(container);
    const before = Object.fromEntries(["media", "images", "sheets", "frames"].map(kind => [kind, cache.get(kind)]));
    queries.length = 0;
    for (let index = 0; index < 3; index++) {
      container.innerHTML = `<section><span>counter ${index}</span></section>`;
      if (delivered) await Bun.sleep(10);
      for (const kind of Object.keys(before)) expect(cache.get(kind)).toBe(before[kind]);
    }
    expect(queries).toEqual([]);
    // Several connected insertion records overlap the same subtree.
    let parent = container;
    for (let index = 0; index < 100; index++) {
      const child = document.createElement("div");
      parent.append(child); parent = child;
    }
    const image = document.createElement("img");
    parent.append(image);
    if (delivered) await Bun.sleep(10);
    expect(cache.get("images")).toEqual([...before.images, image]);
    for (const kind of ["media", "sheets", "frames"]) expect(cache.get(kind)).toBe(before[kind]);
    expect(queries).toEqual(["img"]);
  });
});

test("removed subtrees still invalidate after their resource descendants are detached", async () => {
  for (const delivered of [false, true]) await fixture(async ({ document, cache }) => {
    const kinds = ["media", "images", "sheets", "frames"];
    const original = Object.fromEntries(kinds.map(kind => [kind, [...cache.get(kind)]]));
    const subtree = document.createElement("section");
    subtree.innerHTML = '<div><img><audio></audio><style>p{color:blue}</style><iframe></iframe></div>';
    document.body.append(subtree);
    for (const kind of kinds) expect(cache.get(kind)).toHaveLength(original[kind].length + 1);
    subtree.remove();
    subtree.firstChild.replaceChildren();
    subtree.replaceChildren();
    if (delivered) await Bun.sleep(10);
    for (const kind of kinds) expect(cache.get(kind)).toEqual(original[kind]);
  });
});

test("detached rel edits, reordering and moves into shadow roots refresh old membership", async () => {
  for (const delivered of [false, true]) await fixture(async ({ document, cache }) => {
    const subtree = document.createElement("section");
    subtree.innerHTML = '<link rel="alternate stylesheet"><img id="second">';
    document.body.append(subtree);
    const sheets = cache.get("sheets"), images = cache.get("images");
    const link = subtree.firstChild, second = subtree.lastChild;
    subtree.remove();
    link.setAttribute("rel", "preload");
    document.body.prepend(subtree);
    if (delivered) await Bun.sleep(10);
    expect(cache.get("sheets")).toEqual(sheets.filter(element => element !== link));
    expect(cache.get("images")).toEqual([second, images[0]]);
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).append(second);
    if (delivered) await Bun.sleep(10);
    expect(cache.get("images")).toEqual([images[0]]);
    document.body.append(second);
    expect(cache.get("images")).toEqual([images[0], second]);
  });
});

test("adopting resource subtrees updates discovery in both documents", async () => {
  await fixture(async ({ document, cache }) => {
    const other = parseHTMLDocument("<body></body>");
    const next = createResourceElements(other.document);
    try {
      const image = cache.get("images")[0];
      expect(next.get("images")).toEqual([]);
      const container = document.createElement("section");
      document.body.append(container); container.append(image);
      cache.get("images");
      other.document.body.append(container);
      expect(cache.get("images")).toEqual([]);
      expect(next.get("images")).toEqual([image]);
      container.remove(); container.replaceChildren();
      await Bun.sleep(10);
      expect(next.get("images")).toEqual([]);
    } finally { next.dispose(); await other.window.happyDOM.close(); }
  });
});

test("foreign element tag names follow the same matching rules as discovery selectors", async () => {
  await fixture(async ({ document, cache }) => {
    const selectors = { media: "video, audio", images: "img", sheets: "style, link[rel~='stylesheet']", frames: "iframe" };
    for (const kind of Object.keys(selectors)) cache.get(kind);
    for (const namespace of ["http://www.w3.org/2000/svg", "urn:resource-test"]) {
      for (const name of ["img", "IMG", "ImG", "x:img", "STYLE", "StYle", "LINK", "lInK", "aUdIo", "ViDeO", "IfRaMe"]) {
        const node = document.createElementNS(namespace, name);
        node.setAttribute("rel", "stylesheet");
        document.body.append(node);
        for (const [kind, selector] of Object.entries(selectors)) {
          expect(cache.get(kind)).toEqual([...document.querySelectorAll(selector)]);
        }
        node.remove();
        for (const [kind, selector] of Object.entries(selectors)) {
          expect(cache.get(kind)).toEqual([...document.querySelectorAll(selector)]);
        }
      }
    }
  });
});

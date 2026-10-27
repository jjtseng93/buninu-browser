import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";

const URL = "https://base.test/page/index.html";

/** Runs `body` while counting base[href] lookups per document. */
function countBaseQueries(body) {
  const { window, document } = parseHTMLDocument("", URL);
  // Each window has its own Document subclass; spy where querySelector is defined.
  let prototype = Object.getPrototypeOf(document);
  while (!Object.hasOwn(prototype, "querySelector")) prototype = Object.getPrototypeOf(prototype);
  const original = prototype.querySelector;
  const counts = new Map();
  prototype.querySelector = function(selector) {
    if (selector === "base[href]") counts.set(this, (counts.get(this) ?? 0) + 1);
    return original.call(this, selector);
  };
  try {
    body(document => counts.get(document) ?? 0);
  } finally {
    prototype.querySelector = original;
    window.happyDOM.abort();
  }
}

test("parsing many URL attributes does not scan for <base> once per attribute", () => {
  const html = `<!doctype html><body>${'<a href="x">x</a><img src="y">'.repeat(2000)}</body>`;
  countBaseQueries(queries => {
    const parsed = parseHTMLDocument(html, URL);
    expect(parsed.document.querySelectorAll("a[href], img[src]").length).toBe(4000);
    expect(parsed.document.querySelector("a").href).toBe("https://base.test/page/x");
    expect(queries(parsed.document)).toBeLessThan(10);
    parsed.window.happyDOM.abort();
  });
});

test("the cached base follows insertion, attribute changes and removal", () => {
  const { window, document } = parseHTMLDocument(`<!doctype html><head></head><body><a id="link" href="next">x</a></body>`, URL);
  const link = document.getElementById("link");
  expect([document.baseURI, link.href]).toEqual([URL, "https://base.test/page/next"]);

  const base = document.createElement("base");
  base.setAttribute("href", "/assets/");
  document.head.appendChild(base);
  expect([document.baseURI, link.href]).toEqual(["https://base.test/assets/", "https://base.test/assets/next"]);

  base.setAttribute("href", "/changed/");
  expect(link.href).toBe("https://base.test/changed/next");

  // An earlier base[href] takes over; a later removal of it falls back to the first one.
  const earlier = document.createElement("base");
  earlier.setAttribute("href", "/earlier/");
  document.head.insertBefore(earlier, base);
  expect(document.baseURI).toBe("https://base.test/earlier/");
  earlier.remove();
  expect(document.baseURI).toBe("https://base.test/changed/");

  base.removeAttribute("href");
  expect(document.baseURI).toBe(URL);
  base.setAttribute("href", "/again/");
  expect(document.baseURI).toBe("https://base.test/again/");

  // Removing an ancestor disconnects the base too.
  document.documentElement.removeChild(document.head);
  expect([document.baseURI, link.href]).toEqual([URL, "https://base.test/page/next"]);
  window.happyDOM.abort();
});

test("each document keeps its own base", () => {
  const first = parseHTMLDocument(`<!doctype html><base href="/one/"><a href="x">x</a>`, URL);
  const second = parseHTMLDocument(`<!doctype html><a href="x">x</a>`, URL);
  expect(first.document.baseURI).toBe("https://base.test/one/");
  expect(second.document.baseURI).toBe(URL);
  expect(first.document.querySelector("a").href).toBe("https://base.test/one/x");
  expect(second.document.querySelector("a").href).toBe("https://base.test/page/x");
  first.window.happyDOM.abort();
  second.window.happyDOM.abort();
});

test("a <base> change invalidates only its own document", () => {
  countBaseQueries(queries => {
    const first = parseHTMLDocument(`<!doctype html><base href="/one/"><a href="x">x</a>`, URL);
    const second = parseHTMLDocument(`<!doctype html><a href="x">x</a>`, URL);
    expect([first.document.baseURI, second.document.baseURI]).toEqual(["https://base.test/one/", URL]);
    const before = queries(second.document);
    first.document.querySelector("base").setAttribute("href", "/two/");
    expect(first.document.baseURI).toBe("https://base.test/two/");
    expect(second.document.baseURI).toBe(URL);
    expect(queries(second.document)).toBe(before);
    first.window.happyDOM.abort();
    second.window.happyDOM.abort();
  });
});

test("an adopted <base> leaves its old document and joins the new one", () => {
  const first = parseHTMLDocument(`<!doctype html><head><base href="/one/"></head>`, URL);
  const second = parseHTMLDocument(`<!doctype html><head></head>`, URL);
  expect([first.document.baseURI, second.document.baseURI]).toEqual(["https://base.test/one/", URL]);
  second.document.head.appendChild(second.document.adoptNode(first.document.querySelector("base")));
  expect([first.document.baseURI, second.document.baseURI]).toEqual([URL, "https://base.test/one/"]);
  first.window.happyDOM.abort();
  second.window.happyDOM.abort();
});

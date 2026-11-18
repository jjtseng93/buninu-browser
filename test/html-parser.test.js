import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { RenderTreeBuilder, renderTreeText } from "../lib/render-tree/index.js";

test("formal parser builds an inert Happy DOM document tree", () => {
  const { document, window } = parseHTMLDocument(`<!doctype html>
    <title>A &amp; B</title>
    <body data-page="main">
      before<br>after &copy; 中文 😀
      <p id="unclosed">malformed
      <script>document.title = "script ran"</script>
      <style>body { color: red }</style>
    </body>`, "https://example.test/page");

  expect(document.URL).toBe("https://example.test/page");
  expect(document.title).toBe("A & B");
  expect(document.body.dataset.page).toBe("main");
  expect(document.querySelector("#unclosed")?.tagName).toBe("P");
  const text = renderTreeText(new RenderTreeBuilder().build(document));
  expect(text).toContain("before\nafter © 中文 😀");
  expect(text).not.toContain("script ran");
  expect(text).not.toContain("color: red");
  window.happyDOM.abort();
});

test("places leading metadata in the implicit head", () => {
  const { document, window } = parseHTMLDocument(`<!doctype html>
    <meta charset="utf-8">
    <title>Index of /</title>
    <style>body { color: red }</style>
    <h1>Index of /</h1>`);

  expect(document.head.querySelector("title")?.textContent).toBe("Index of /");
  expect(document.head.querySelector("meta")?.getAttribute("charset")).toBe("utf-8");
  expect(document.head.querySelector("style")?.textContent).toContain("color: red");
  expect(document.body.querySelector("title")).toBeNull();
  expect(document.body.textContent.trim()).toBe("Index of /");
  expect(document.body.firstChild.tagName).toBe("H1");
  window.happyDOM.abort();
});

test("missing title lookups share invalidation records until the tree changes", async () => {
  const { affectsCache } = await import("../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts");
  const { document, window } = parseHTMLDocument("<body><i></i></body>", "https://example.test/");
  const leaf = document.body.firstChild;
  expect(document.title).toBe("");
  const records = leaf[affectsCache].length;
  for (let i = 0; i < 10; i++) expect(document.title).toBe("");
  expect(leaf[affectsCache].length).toBe(records);
  const title = document.createElement("title");
  title.textContent = "Updated";
  document.head.appendChild(title);
  expect(document.title).toBe("Updated");
  title.remove();
  expect(document.title).toBe("");
  window.happyDOM.abort();
});

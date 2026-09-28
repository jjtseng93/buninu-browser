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

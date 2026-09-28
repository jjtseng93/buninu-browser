import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { RenderTreeBuilder, renderTreeText } from "../lib/render-tree/index.js";

test("builds an engine-owned tree and excludes non-rendered DOM nodes", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <div id="block">hello <span id="inline">中文 😀</span><br>next</div>
    <p hidden>hidden attribute</p>
    <script>script source</script><style>style source</style>
  </body>`);
  const tree = new RenderTreeBuilder().build(document);
  const block = [...tree.nodesById.values()].find((node) => node.domNode.id === "block");
  const inline = [...tree.nodesById.values()].find((node) => node.domNode.id === "inline");

  expect(tree.root.type).toBe("root");
  expect(tree.root.tagName).toBe("BODY");
  expect(block.type).toBe("block");
  expect(inline.type).toBe("inline");
  expect(renderTreeText(tree)).toContain("hello 中文 😀\nnext");
  expect(renderTreeText(tree)).not.toContain("hidden attribute");
  expect(renderTreeText(tree)).not.toContain("script source");
  window.happyDOM.abort();
});

test("keeps node IDs stable across generations of the same DOM", () => {
  const { document, window } = parseHTMLDocument(`<body><p id="item">before</p></body>`);
  const builder = new RenderTreeBuilder();
  const first = builder.build(document);
  const element = document.querySelector("#item");
  const firstNode = [...first.nodesById.values()].find((node) => node.domNode === element);

  element.firstChild.data = "after";
  const second = builder.build(document);
  const secondNode = second.nodesById.get(firstNode.id);

  expect(second.generation).toBe(first.generation + 1);
  expect(secondNode.domNode).toBe(element);
  expect(secondNode.id).toBe(firstNode.id);
  expect(renderTreeText(second)).toContain("after");
  window.happyDOM.abort();
});


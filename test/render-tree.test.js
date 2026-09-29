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

test("includes visible elements appended beside body under html", async () => {
  const { StyleEngine } = await import("../lib/style/computed-style.js");
  const { document, window } = parseHTMLDocument(`<html><head></head><body><p>body</p></body></html>`);
  const badge = document.createElement("div");
  badge.id = "badge";
  badge.style.cssText = "position:fixed;left:20px;top:30px;background:red";
  badge.textContent = "overlay";
  document.documentElement.appendChild(badge);

  const tree = new RenderTreeBuilder().build(document, new StyleEngine().compute(document));
  expect(tree.root.tagName).toBe("BODY");
  expect(tree.root.children.at(-1).domNode).toBe(badge);
  expect(tree.root.children.at(-1).style.position).toBe("fixed");
  expect(renderTreeText(tree)).toContain("overlay");
  window.happyDOM.abort();
});

test("never creates boxes for metadata misplaced in body", () => {
  const { document, window } = parseHTMLDocument(`<body>
    <h1>painted once</h1><title>not painted</title><meta name="x">
  </body>`);
  const tree = new RenderTreeBuilder().build(document);

  expect(renderTreeText(tree).match(/painted once/g)).toHaveLength(1);
  expect(renderTreeText(tree)).not.toContain("not painted");
  window.happyDOM.abort();
});

test("form controls render their live value, placeholder, selection and checked state", async () => {
  const { StyleEngine } = await import("../lib/style/computed-style.js");
  const { document, window } = parseHTMLDocument(`<body>
    <textarea id="area" rows="3">initial</textarea>
    <input id="empty" placeholder="type here"><input id="secret" type="password" value="abc">
    <input id="box" type="checkbox" checked><input id="off" type="checkbox"><input type="hidden" value="h">
    <select id="pick"><option>one</option><option selected>two</option></select>
    <input id="submit" type="submit"><button id="button"><b>bold</b> label</button>
  </body>`);
  document.getElementById("area").value = "changed\nby script";
  const engine = new StyleEngine().compute(document);
  const tree = new RenderTreeBuilder().build(document, engine);
  const node = (id) => [...tree.nodesById.values()].find((candidate) => candidate.domNode.id === id && !candidate.pseudo);
  const text = (id) => node(id).children.map((child) => child.text).join("");

  expect(text("area")).toBe("changed\nby script");
  expect(node("area").style).toMatchObject({ whiteSpace: "pre-wrap", fontFamily: ["monospace"] });
  // Three rows of 13.333px * 1.2 lines, plus 2px padding and 1px border on each side.
  expect(node("area").style.minHeight).toBeCloseTo(3 * 13.333 * 1.2, 2);
  expect(text("empty")).toBe("type here");
  expect(node("empty").children[0].style.color).toBe("rgba(117, 117, 117, 1)");
  expect(text("secret")).toBe("•••");
  expect(text("box")).toBe("✓");
  expect(node("box").style.backgroundColor).toBe("rgba(0, 117, 255, 1)");
  expect(text("off")).toBe("");
  expect(renderTreeText(tree)).not.toContain("h\n");
  expect(text("pick")).toBe("two ▾");
  expect(text("submit")).toBe("Submit");
  // A <button> keeps its own content.
  expect(node("button").type).toBe("inline-block");
  expect(renderTreeText(tree)).toContain("bold label");
  window.happyDOM.abort();
});

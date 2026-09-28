const NON_RENDERED_ELEMENTS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
]);

const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DIV", "DL", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL",
]);

/**
 * Builds the engine-owned render representation from the authoritative DOM.
 * IDs remain stable when the same DOM node appears in a later generation.
 */
export class RenderTreeBuilder {
  #ids = new WeakMap();
  #nextId = 1;
  #generation = 0;

  build(document) {
    const nodesById = new Map();
    const body = document.body;
    const root = body
      ? this.#element(body, nodesById, true)
      : this.#node(document, "root", nodesById, { tagName: null, children: [] });

    return Object.freeze({
      generation: ++this.#generation,
      root,
      nodesById,
    });
  }

  #id(domNode) {
    let id = this.#ids.get(domNode);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(domNode, id);
    }
    return id;
  }

  #node(domNode, type, nodesById, properties) {
    const node = Object.freeze({
      id: this.#id(domNode),
      type,
      domNode,
      ...properties,
    });
    nodesById.set(node.id, node);
    return node;
  }

  #element(element, nodesById, isRoot = false) {
    if (!isRoot && (NON_RENDERED_ELEMENTS.has(element.tagName) || element.hasAttribute("hidden"))) {
      return null;
    }
    if (element.tagName === "BR") {
      return this.#node(element, "line-break", nodesById, {
        tagName: "BR",
        children: Object.freeze([]),
      });
    }

    const children = [];
    for (const child of element.childNodes) {
      let rendered = null;
      if (child.nodeType === 3) {
        rendered = this.#node(child, "text", nodesById, {
          text: child.data ?? child.textContent ?? "",
          children: Object.freeze([]),
        });
      } else if (child.nodeType === 1) {
        rendered = this.#element(child, nodesById);
      }
      if (rendered) children.push(rendered);
    }

    return this.#node(element, isRoot ? "root" : BLOCK_ELEMENTS.has(element.tagName) ? "block" : "inline", nodesById, {
      tagName: element.tagName,
      children: Object.freeze(children),
    });
  }
}

/** Temporary text layout input until fragments and line boxes are introduced. */
export function renderTreeText(tree) {
  const lines = [""];

  function visit(node) {
    if (node.type === "text") {
      lines[lines.length - 1] += node.text;
      return;
    }
    if (node.type === "line-break") {
      if (lines[lines.length - 1] !== "") lines.push("");
      return;
    }
    for (const child of node.children) visit(child);
  }

  visit(tree.root);
  return lines.join("\n");
}


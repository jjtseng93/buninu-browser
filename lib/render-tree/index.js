const NON_RENDERED_ELEMENTS = new Set([
  "BASE",
  "BASEFONT",
  "BGSOUND",
  "HEAD",
  "LINK",
  "META",
  "NOFRAMES",
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TITLE",
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
  #pseudoKeys = new WeakMap();
  #nextId = 1;
  #generation = 0;

  build(document, styleEngine = null, resources = null) {
    const nodesById = new Map();
    const body = document.body;
    const root = body
      ? this.#element(body, nodesById, true, styleEngine, resources)
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

  #node(domNode, type, nodesById, properties, idKey = domNode) {
    const node = Object.freeze({
      id: this.#id(idKey),
      type,
      domNode,
      ...properties,
    });
    nodesById.set(node.id, node);
    return node;
  }

  /**
   * ::before/::after boxes. They belong to the originating element for hit
   * testing (domNode) but take stable IDs from per-element pseudo keys.
   */
  #pseudo(element, pseudo, styleEngine, nodesById) {
    const style = styleEngine?.getPseudo?.(element, pseudo);
    if (!style) return null;
    let keys = this.#pseudoKeys.get(element);
    if (!keys) this.#pseudoKeys.set(element, keys = { before: {}, after: {}, beforeText: {}, afterText: {} });
    const children = style.content
      ? [this.#node(element, "text", nodesById, {
        text: style.content,
        style,
        children: Object.freeze([]),
      }, keys[`${pseudo}Text`])]
      : [];
    return this.#node(element, boxType(style), nodesById, {
      tagName: `::${pseudo}`,
      pseudo,
      style,
      children: Object.freeze(children),
    }, keys[pseudo]);
  }

  #element(element, nodesById, isRoot = false, styleEngine = null, resources = null) {
    const style = styleEngine?.get(element) ?? null;
    if (!isRoot && (style?.display === "none" || NON_RENDERED_ELEMENTS.has(element.tagName) || element.hasAttribute("hidden"))) {
      return null;
    }
    if (element.tagName === "BR") {
      return this.#node(element, "line-break", nodesById, {
        tagName: "BR",
        style,
        children: Object.freeze([]),
      });
    }
    if (element.tagName === "IMG") {
      return this.#node(element, "image", nodesById, {
        tagName: "IMG",
        style,
        resource: resources?.get(element) ?? null,
        widthAttribute: positiveDimension(element.getAttribute("width")),
        heightAttribute: positiveDimension(element.getAttribute("height")),
        children: Object.freeze([]),
      });
    }

    const children = [];
    const before = this.#pseudo(element, "before", styleEngine, nodesById);
    if (before) children.push(before);
    for (const child of element.childNodes) {
      let rendered = null;
      if (child.nodeType === 3) {
        rendered = this.#node(child, "text", nodesById, {
          text: child.data ?? child.textContent ?? "",
          style,
          children: Object.freeze([]),
        });
      } else if (child.nodeType === 1) {
        rendered = this.#element(child, nodesById, false, styleEngine, resources);
      }
      if (rendered) children.push(rendered);
    }
    const after = this.#pseudo(element, "after", styleEngine, nodesById);
    if (after) children.push(after);

    const type = isRoot ? "root" : boxType(style, element.tagName);
    return this.#node(element, type, nodesById, {
      tagName: element.tagName,
      style,
      children: Object.freeze(children),
    });
  }
}

function boxType(style, tagName = null) {
  const display = style?.display;
  if (["flex", "inline-flex", "inline-block", "grid", "inline-grid"].includes(display)) return display;
  return ["block", "list-item"].includes(display) || BLOCK_ELEMENTS.has(tagName) ? "block" : "inline";
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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

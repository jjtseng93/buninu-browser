import { extractSvg } from "./svg.js";
import { controlKind } from "../style/computed-style.js";

const PLACEHOLDER_COLOR = "rgba(117, 117, 117, 1)";
const CHECKED_COLOR = "rgba(0, 117, 255, 1)";
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
    let root = body
      ? this.#element(body, nodesById, true, styleEngine, resources)
      : this.#node(document, "root", nodesById, { tagName: null, children: [] });
    // DOM scripts can append visible elements directly to <html>, outside
    // <body> (for example casty's fixed-position click marker). Include those
    // siblings without changing the body's established root layout.
    if (body && document.documentElement) {
      const siblings = [...document.documentElement.children]
        .filter((element) => element !== body && element.tagName !== "HEAD")
        .map((element) => this.#element(element, nodesById, false, styleEngine, resources))
        .filter(Boolean);
      if (siblings.length) {
        root = Object.freeze({ ...root, children: Object.freeze([...root.children, ...siblings]) });
        nodesById.set(root.id, root);
      }
    }

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
   * Form controls show their current state, not their DOM children: a
   * textarea or text input its value (or placeholder), a select its selected
   * option, an input button its label, and a checked checkbox or radio a mark.
   */
  #control(element, control, style, nodesById) {
    let keys = this.#pseudoKeys.get(element);
    if (!keys) this.#pseudoKeys.set(element, keys = { before: {}, after: {}, beforeText: {}, afterText: {} });
    keys.value ??= {};
    let boxStyle = style;
    let text = "";
    let textStyle = style;
    if (control === "checkbox" || control === "radio") {
      if (element.checked) {
        boxStyle = Object.freeze({
          ...style,
          backgroundColor: CHECKED_COLOR,
          borderColors: Object.freeze([CHECKED_COLOR, CHECKED_COLOR, CHECKED_COLOR, CHECKED_COLOR]),
          color: "rgba(255, 255, 255, 1)",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 11,
          lineHeightFactor: null,
          textAlign: "center",
          whiteSpace: "pre",
        });
        textStyle = boxStyle;
        text = control === "checkbox" ? "✓" : "●";
      }
    } else if (control === "select") {
      const option = element.selectedOptions?.[0] ?? element.querySelector?.("option");
      text = `${(option?.label || option?.textContent || "").trim()} ▾`;
    } else if (control === "button") {
      const type = String(element.getAttribute("type") ?? "").toLowerCase();
      text = element.value || { submit: "Submit", reset: "Reset", file: "Choose File" }[type] || "";
    } else {
      const value = String(element.value ?? "");
      const type = String(element.getAttribute("type") ?? "text").toLowerCase();
      text = type === "password" ? "•".repeat([...value].length) : value;
      if (!text && element.getAttribute("placeholder")) {
        text = element.getAttribute("placeholder");
        textStyle = Object.freeze({ ...style, color: PLACEHOLDER_COLOR });
      }
    }
    const children = text
      ? [this.#node(element, "text", nodesById, { text, style: textStyle, pseudo: "value", children: Object.freeze([]) }, keys.value)]
      : [];
    return this.#node(element, "inline-block", nodesById, {
      tagName: element.tagName,
      style: boxStyle,
      children: Object.freeze(children),
    });
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
    if (element.localName === "svg") {
      // Inline SVG is a replaced element; its shapes are drawn into its box.
      const svg = extractSvg(element, style?.color ?? "rgba(0, 0, 0, 1)");
      const [, , viewWidth, viewHeight] = svg.viewBox ?? [];
      return this.#node(element, "image", nodesById, {
        tagName: "SVG",
        style,
        resource: null,
        svg,
        widthAttribute: svg.width ?? (svg.height && viewWidth ? svg.height * viewWidth / viewHeight : viewWidth ?? null),
        heightAttribute: svg.height ?? (svg.width && viewHeight ? svg.width * viewHeight / viewWidth : viewHeight ?? null),
        children: Object.freeze([]),
      });
    }
    // Audio is a 300x32 player (painted like video's controls) with the
    // controls attribute, and not rendered without it (HTML §4.8.11.13).
    if (element.tagName === "AUDIO") {
      if (!element.hasAttribute("controls")) return null;
      return this.#node(element, "image", nodesById, {
        tagName: "AUDIO",
        style,
        resource: resources?.get(element) ?? null,
        widthAttribute: positiveDimension(element.getAttribute("width")) ?? 300,
        heightAttribute: 32,
        children: Object.freeze([]),
      });
    }
    if (element.tagName === "IMG" || element.tagName === "VIDEO") {
      return this.#node(element, "image", nodesById, {
        tagName: element.tagName,
        style,
        resource: resources?.get(element) ?? null,
        widthAttribute: positiveDimension(element.getAttribute("width")),
        heightAttribute: positiveDimension(element.getAttribute("height")),
        children: Object.freeze([]),
      });
    }

    const control = style ? controlKind(element) : null;
    if (control && control !== "button" || (control === "button" && element.tagName === "INPUT")) {
      return this.#control(element, control, style, nodesById);
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
  if (["table", "inline-table", "table-row-group", "table-header-group", "table-footer-group", "table-row",
    "table-cell", "table-caption", "table-column", "table-column-group"].includes(display)) return display;
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

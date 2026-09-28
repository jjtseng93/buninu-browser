import HTMLParser from "../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts";
import Window from "../../vendor/happy-dom/packages/happy-dom/src/window/Window.ts";

const SKIPPED_TEXT_ELEMENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * Creates an inert Happy DOM document from an HTML response.
 *
 * Page JavaScript and subresource loading stay disabled here. They belong to
 * the renderer scheduler and network service rather than the tree builder.
 */
export function parseHTMLDocument(html, url = "about:blank") {
  const window = new Window({
    url,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      enableImageFileLoading: false,
    },
  });

  new HTMLParser(window).parse(String(html), window.document);
  return { window, document: window.document };
}

/**
 * Produces the temporary plain-text paint input from the authoritative DOM.
 * Layout will eventually replace this traversal; keeping it here ensures the
 * renderer no longer parses HTML with regular expressions.
 */
export function documentText(document) {
  const lines = [""];

  function append(value) {
    lines[lines.length - 1] += value;
  }

  function newline() {
    if (lines[lines.length - 1] !== "") lines.push("");
  }

  function visit(node) {
    if (node.nodeType === 3) {
      append(node.data ?? node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;

    if (SKIPPED_TEXT_ELEMENTS.has(node.tagName)) return;
    if (node.tagName === "BR") {
      newline();
      return;
    }
    for (const child of node.childNodes) visit(child);
  }

  if (document.body) visit(document.body);
  return lines.join("\n");
}


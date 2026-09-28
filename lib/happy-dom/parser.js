import HTMLParser from "../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts";
import Window from "../../vendor/happy-dom/packages/happy-dom/src/window/Window.ts";

const IMPLICIT_HEAD_ELEMENTS = new Set([
  "BASE", "BASEFONT", "BGSOUND", "LINK", "META", "NOFRAMES", "SCRIPT", "STYLE", "TEMPLATE", "TITLE",
]);

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
  normalizeImplicitHead(window.document);
  return { window, document: window.document };
}

/**
 * Happy DOM 20's parser places metadata in body when source omits explicit
 * head/body tags. HTML's "before head" and "in head" insertion modes instead
 * put leading metadata elements into the implicit head.
 */
function normalizeImplicitHead(document) {
  const { head, body } = document;
  if (!head || !body) return;

  let bodyContentStarted = false;
  for (const node of [...body.childNodes]) {
    if (!bodyContentStarted && node.nodeType === 3 && !node.textContent.trim()) {
      node.remove();
      continue;
    }
    if (node.nodeType === 8) continue;
    if (!bodyContentStarted && node.nodeType === 1 && IMPLICIT_HEAD_ELEMENTS.has(node.tagName)) {
      head.appendChild(node);
      continue;
    }
    bodyContentStarted = true;
  }
}

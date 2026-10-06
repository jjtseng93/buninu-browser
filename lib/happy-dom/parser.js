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
  normalizeImplicitHead(window.document, implicitHeadCount(String(html)));
  return { window, document: window.document };
}

/**
 * How many leading metadata elements belong in the implicit head: with no
 * <head> tag, those before an explicit <body> tag (all of them without one).
 * With a <head> tag Happy DOM places them itself. Comments and the contents
 * of raw-text elements are skipped so that text in them is not counted.
 */
function implicitHeadCount(html) {
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|textarea|title|template|noframes)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, "<$1$2></$1>");
  if (/<head[\s>\/]/i.test(source)) return 0;
  const bodyAt = source.search(/<body[\s>\/]/i);
  if (bodyAt < 0) return Infinity;
  return (source.slice(0, bodyAt).match(/<(base|basefont|bgsound|link|meta|noframes|script|style|template|title)\b/gi) ?? []).length;
}

/**
 * Happy DOM 20's parser places metadata in body when source omits explicit
 * head/body tags. HTML's "before head" and "in head" insertion modes instead
 * put leading metadata elements into the implicit head; once the <body> tag
 * has been seen, metadata stays in body (`limit` counts those before it).
 */
function normalizeImplicitHead(document, limit) {
  const { head, body } = document;
  if (!head || !body || limit <= 0) return;

  let moved = 0;
  let bodyContentStarted = false;
  for (const node of [...body.childNodes]) {
    if (moved >= limit) break;
    if (!bodyContentStarted && node.nodeType === 3 && !node.textContent.trim()) {
      node.remove();
      continue;
    }
    if (node.nodeType === 8) continue;
    if (!bodyContentStarted && node.nodeType === 1 && IMPLICIT_HEAD_ELEMENTS.has(node.tagName)) {
      head.appendChild(node);
      moved++;
      continue;
    }
    bodyContentStarted = true;
  }
}

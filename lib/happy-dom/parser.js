import HTMLParser from "../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts";
import Window from "../../vendor/happy-dom/packages/happy-dom/src/window/Window.ts";

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

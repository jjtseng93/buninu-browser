import Node from "../../vendor/happy-dom/packages/happy-dom/src/nodes/node/Node.ts";
import Document from "../../vendor/happy-dom/packages/happy-dom/src/nodes/document/Document.ts";
import HTMLHyperlinkElementUtility from "../../vendor/happy-dom/packages/happy-dom/src/nodes/html-hyperlink-element/HTMLHyperlinkElementUtility.ts";

/** HTML document base URL, shared by the inert DOM and its page bindings. */
export function documentBaseURL(node) {
  const document = node?.nodeType === 9 ? node : node?.ownerDocument;
  const fallback = document?.URL ?? "about:blank";
  const base = document?.querySelector?.("base[href]");
  if (!base) return fallback;
  try {
    const url = new URL(base.getAttribute("href"), fallback);
    return url.protocol === "data:" || url.protocol === "javascript:" ? fallback : url.href;
  } catch { return fallback; }
}

// Happy DOM selects the first <base>, including ones with only a target.
// Correcting both accessors keeps native URL attributes and renderer loads
// on the same base, without modifying the vendored implementation.
for (const prototype of [Node.prototype, Document.prototype]) {
  Object.defineProperty(prototype, "baseURI", {
    configurable: true, get() { return documentBaseURL(this); },
  });
}

// Hyperlink component accessors use this shared method, so pathname/search
// setters and origin/hash getters resolve consistently with href itself.
HTMLHyperlinkElementUtility.prototype.getHref = function () {
  const value = this.element.getAttribute("href");
  if (value === null) return "";
  try { return new URL(value, documentBaseURL(this.element)).href; }
  catch { return value; }
};

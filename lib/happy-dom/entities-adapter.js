/**
 * The subset of the `entities` package API used by Happy DOM.
 *
 * Bun already ships the WHATWG named-entity table for Bun.markdown. Keep the
 * dependency boundary here so this can switch to a direct Bun decoder if one
 * becomes public later.
 */

const HTML_REFERENCE = /&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,47});/g;
const XML_REFERENCE = /&(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|apos|gt|lt|quot);/g;
const decodedReferences = new Map();

const markdownCallbacks = {
  paragraph: (children) => children,
  text: (text) => text,
};

function decodeReference(reference) {
  let decoded = decodedReferences.get(reference);
  if (decoded === undefined) {
    decoded = Bun.markdown.render(reference, markdownCallbacks);
    decodedReferences.set(reference, decoded);
  }
  return decoded;
}

function decode(value, pattern) {
  return String(value).replace(pattern, decodeReference);
}

export function decodeHTML(value) {
  return decode(value, HTML_REFERENCE);
}

export function decodeHTMLAttribute(value) {
  return decode(value, HTML_REFERENCE);
}

export function decodeXML(value) {
  return decode(value, XML_REFERENCE);
}

export function escapeText(value) {
  return String(value).replace(/[&<>\u00A0]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\u00A0": "&nbsp;",
  })[character]);
}


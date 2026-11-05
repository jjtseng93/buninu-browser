import {createInertWindow} from '../happy-dom/parser.js';
import {parseXMLTree} from '../happy-dom/xml-tree-parser.js';
import {prepareActiveDocument, setDocumentEncoding} from './document-constructor.js';

const HTML = 'http://www.w3.org/1999/xhtml';

/** XML navigation owns an active XML document, not HTML with a MIME label.
 * Only the renderer executes its scripts after the inert tree is complete. */
export function parseActiveXMLDocument(source, url, {
  contentType = 'application/xml', referrer = '', encoding = 'UTF-8', parseError = null,
} = {}) {
  const window = createInertWindow(url);
  try {
    const result = parseError ? {valid:false,error:parseError} : parseXMLTree(window, source);
    let document = result.document;
    if (!result.valid) {
      // Fatal XML errors cannot leave an executable partial source document.
      // Build text nodes for the diagnostic so source/error markup is inert.
      document = new window.XMLDocument();
      const html = document.createElementNS(HTML, 'html');
      const body = document.createElementNS(HTML, 'body');
      const error = document.createElementNS(HTML, 'parsererror');
      error.setAttribute('style', 'display:block;white-space:pre-wrap;border:2px solid #c77;padding:1em;color:#900;background:#fee');
      error.textContent = `XML parsing error: ${result.error || 'Malformed XML'}`;
      document.appendChild(html);html.appendChild(body);body.appendChild(error);
    }
    prepareActiveDocument(document, {contentType,url,referrer});
    setDocumentEncoding(document, encoding);
    return {window,document};
  } catch(error) { window.happyDOM.close();throw error; }
}

export function parseXHTMLDocument(source, url, referrer = '') {
  return parseActiveXMLDocument(source, url, {contentType:'application/xhtml+xml',referrer});
}

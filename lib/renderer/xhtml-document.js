import {createInertWindow} from '../happy-dom/parser.js';
import {parseXMLTree} from '../happy-dom/xml-tree-parser.js';
import {prepareActiveDocument} from './document-constructor.js';

const HTML = 'http://www.w3.org/1999/xhtml';

/** XHTML is an active XML document, not HTML with a different MIME label.
 * Only the renderer executes its scripts after the inert tree is complete. */
export function parseXHTMLDocument(source, url, referrer = '') {
  const window = createInertWindow(url);
  try {
    const result = parseXMLTree(window, source);
    let document = result.document;
    if (!result.valid) {
      // Fatal XML errors cannot leave an executable partial source document.
      // Build text nodes for the diagnostic so source/error markup is inert.
      document = new window.XMLDocument();
      const html = document.createElementNS(HTML, 'html');
      const body = document.createElementNS(HTML, 'body');
      const error = document.createElementNS(HTML, 'parsererror');
      error.setAttribute('style', 'display:block;white-space:pre-wrap;border:2px solid #c77;padding:1em;color:#900;background:#fee');
      error.textContent = `XML parsing error: ${result.error || 'Malformed XHTML'}`;
      document.appendChild(html);html.appendChild(body);body.appendChild(error);
    }
    prepareActiveDocument(document, {contentType:'application/xhtml+xml',url,referrer});
    return {window,document};
  } catch(error) { window.happyDOM.close();throw error; }
}

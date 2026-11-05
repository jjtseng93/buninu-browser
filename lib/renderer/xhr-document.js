import {parseXMLTree} from '../happy-dom/xml-tree-parser.js';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {prepareDetachedDocument, setDocumentEncoding} from './document-constructor.js';
import {decodeXHRResponse, xhrResponseEncoding} from './xhr-response.js';

export function isXMLMimeType(type) {
  return type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml');
}

/** XHR's detached document response. The caller owns/reuses its inert parser
 * window and closes it on page disposal; no page, evaluator or resource loader
 * is created here. Bun's optional XML validator never loads external entities
 * and bounds internal entity expansion. Older runtimes retain native parser
 * validation plus the XML character check, without a second custom parser. */
export function xhrDocumentResponse({bytes, responseType, metadata, url, sourceDocument, window}) {
  const xml = isXMLMimeType(metadata.essence);
  if (!xml && (metadata.essence !== 'text/html' || responseType !== 'document')) return null;
  // An absent response body is represented separately by the caller. Empty
  // XML fails parsing; an empty HTML response still creates an HTML document.
  let parsed;
  if (xml) {
    try {
      const text = decodeXHRResponse(bytes, 'document', metadata, {fatal:true});
      const result = parseXMLTree(window, text);
      if (!result.valid) return null;
      parsed = result.document;
    } catch { return null; }
  } else parsed = new window.DOMParser().parseFromString(decodeXHRResponse(bytes, 'document', metadata), 'text/html');
  prepareDetachedDocument(parsed, {contentType:metadata.essence, url, sourceDocument});
  parsed[S.readyState] = 'complete';
  setDocumentEncoding(parsed, xhrResponseEncoding(bytes, 'document', metadata));
  return parsed;
}

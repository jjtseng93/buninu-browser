import {MIMEType} from 'node:util';

const Decoder = globalThis.TextDecoder;
const NativeBlob = globalThis.Blob;
const replacementLabels = new Set(['replacement', 'csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr']);

function mimeType(value) {
  try { return new MIMEType(value); } catch { return null; }
}

export function xhrOverrideMimeType(value) {
  return mimeType(value) ?? new MIMEType('application/octet-stream');
}

// XHR's final encoding intentionally falls back to the RESPONSE charset when
// an override changes only the MIME type. A malformed override still changes
// the final MIME type, but has no charset of its own.
export function xhrResponseMetadata(contentType, override = null) {
  const response = mimeType(contentType ?? '') ?? new MIMEType('text/xml');
  const final = override ?? response;
  const label = override?.params.has('charset') ? override.params.get('charset') : response.params.get('charset');
  return {mimeType: final.toString(), essence: final.essence, encoding: encoding(label)};
}

export function xhrResponseBlob(bytes, metadata) {
  const blob = new NativeBlob([bytes], {type: metadata.mimeType});
  // XHR assigns its parsed MIME record directly. Blob's public constructor
  // lowercases parameters, rejects non-ASCII and Bun may add a UTF-8 charset;
  // preserve the native bytes/brand but expose the required response type.
  if (blob.type !== metadata.mimeType) Object.defineProperty(blob, 'type', {value:metadata.mimeType,configurable:true});
  return blob;
}

function encoding(label) {
  if (label === null) return null;
  const normalized = String(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  // TextDecoder rejects replacement by design, but Encoding's legacy decode
  // algorithm still recognizes these labels and returns one replacement.
  if (replacementLabels.has(normalized)) return 'replacement';
  try { return new Decoder(normalized).encoding; } catch { return null; }
}

function bomEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function xmlEncoding(bytes) {
  // XML's no-BOM UTF-16 signatures. Other byte encodings declare an ASCII
  // encoding name in the initial XML declaration; HTML meta is never sniffed.
  if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) return 'utf-16be';
  if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) return 'utf-16le';
  if (bytes[0] !== 0x3c || bytes[1] !== 0x3f || bytes[2] !== 0x78 || bytes[3] !== 0x6d || bytes[4] !== 0x6c) return null;
  // Read only the declaration's version and encoding pseudo-attributes. Do
  // not duplicate an entire malformed XML response while searching for "?>".
  let at = 5;
  const space = byte => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  const spaces = () => { const start = at; while (space(bytes[at])) at++; return at !== start; };
  const word = value => { for (let i = 0; i < value.length; i++) if (bytes[at++] !== value.charCodeAt(i)) return false; return true; };
  const quote = () => { spaces(); if (bytes[at++] !== 0x3d) return null; spaces(); const q=bytes[at++]; return q===0x22||q===0x27?q:null; };
  if (!spaces() || !word('version')) return null;
  const versionQuote = quote();
  if (!versionQuote || !word('1.')) return null;
  const digits = at;
  while (bytes[at] >= 0x30 && bytes[at] <= 0x39) at++;
  if (at === digits || bytes[at++] !== versionQuote || !spaces() || !word('encoding')) return null;
  const encodingQuote = quote();
  if (!encodingQuote) return null;
  let label = '';
  // All Encoding Standard labels are shorter than this. Bound invalid tokens
  // as well, without decoding or copying any following document content.
  while (at < bytes.length && label.length < 128) {
    const byte = bytes[at++];
    if (byte === encodingQuote) return label;
    const letter = byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a;
    if (!letter && (!label || !(byte >= 0x30 && byte <= 0x39 || byte === 0x2e || byte === 0x5f || byte === 0x2d))) return null;
    label += String.fromCharCode(byte);
  }
  // An overlong declaration is present but cannot name a supported encoding.
  // Keep it distinct from absence for XML's fatal document decoding; ordinary
  // responseText still falls back to UTF-8 without scanning an unbounded label.
  return label.length === 128 ? label : null;
}

export function xhrResponseEncoding(buffer, responseType, metadata, {fatal = false} = {}) {
  const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  // JSON always uses UTF-8; it does not apply the general UTF-16 BOM override.
  if (responseType === 'json') return 'utf-8';
  let selected = bomEncoding(bytes) ?? metadata.encoding;
  if (!selected && (responseType === '' || responseType === 'document') && (metadata.essence === 'text/xml' || metadata.essence === 'application/xml' || metadata.essence.endsWith('+xml'))) {
    const declared = xmlEncoding(bytes);
    selected = encoding(declared);
    if (fatal && declared !== null && !selected) throw new TypeError('Unsupported XML encoding');
  }
  return selected ?? 'utf-8';
}

export function decodeXHRResponse(buffer, responseType, metadata, {fatal = false} = {}) {
  const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  const selected = xhrResponseEncoding(bytes, responseType, metadata, {fatal});
  if (selected === 'replacement') {
    if (fatal && bytes.length) throw new TypeError('Invalid XML encoding');
    return bytes.length ? '\ufffd' : '';
  }
  return new Decoder(selected, {fatal}).decode(bytes);
}

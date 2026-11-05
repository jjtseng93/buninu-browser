import {encodingString} from './encoding-string.js';
import {isNativeBlob,blobParts} from './blob.js';

const NativeBlob = globalThis.Blob;
const entries = globalThis.FormData.prototype.entries;
const params = globalThis.URLSearchParams.prototype.toString;
const blobSize = Object.getOwnPropertyDescriptor(NativeBlob.prototype, 'size').get;
const blobType = Object.getOwnPropertyDescriptor(NativeBlob.prototype, 'type').get;
const fileName = Object.getOwnPropertyDescriptor(globalThis.File.prototype, 'name').get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const sharedLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const branded = (get, value) => {try {get.call(value);return true;} catch {return false;}};
const crlf = value => value.replace(/\r\n|\r|\n/g, '\r\n');
const escape = value => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

// Extract one immutable body before loadstart. Its byte length is then known
// synchronously, and mutations to a view/FormData in a listener cannot change
// the bytes being uploaded. Native Blob parts retain files without reading
// their contents on the renderer's JS thread.
export function xhrBody(value, {document = null, serialize = null, error = (_name, message) => new TypeError(message)} = {}) {
  if (value == null) return {body:null, length:0, type:null};
  if (branded(sharedLength,value)) throw error('TypeError','Shared buffers are not allowed');
  let body, type = null;
  if (document) {
    type = document.contentType === 'text/html' ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8';
    body = new NativeBlob([serialize(document)]);
  } else if (isNativeBlob(value)) {
    body = value;
    type = blobType.call(value) || null;
  } else if (ArrayBuffer.isView(value) || branded(bufferLength,value)) {
    const parts = blobParts([value], error);
    try { body = new NativeBlob(parts); }
    catch (caught) { throw error('TypeError', caught.message); }
  } else {
    let list = null, encoded = null;
    try { list = [...entries.call(value)]; } catch {}
    if (list) {
      const boundary = '----buninu-' + crypto.randomUUID();
      type = 'multipart/form-data; boundary=' + boundary;
      const parts = [];
      for (const [name, item] of list) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escape(crlf(name))}"`;
        if (isNativeBlob(item)) {
          head += `; filename="${escape(fileName.call(item))}"\r\nContent-Type: ${blobType.call(item) || 'application/octet-stream'}`;
          parts.push(head + '\r\n\r\n', item, '\r\n');
        } else parts.push(head + '\r\n\r\n', crlf(item), '\r\n');
      }
      parts.push(`--${boundary}--\r\n`);
      body = new NativeBlob(parts);
    } else {
      try { encoded = params.call(value); } catch {}
      if (encoded !== null) type = 'application/x-www-form-urlencoded;charset=UTF-8';
      else { encoded = encodingString(value, error).toWellFormed(); type = 'text/plain;charset=UTF-8'; }
      body = new NativeBlob([encoded]);
    }
  }
  return {body, length:blobSize.call(body), type};
}

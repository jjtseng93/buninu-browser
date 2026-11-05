import {encodingString} from './encoding-string.js';
// Keep Bun's streaming decoder, but expose a page-local WebIDL boundary.
// Never catch user conversion/getter exceptions in the native-error adapter.
const NativeDecoder = globalThis.TextDecoder;
const decoders = new WeakMap();
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const sharedBufferLength = typeof SharedArrayBuffer === 'function'
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get : null;

export function textDecoderInterface(global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  const native = (operation) => {
    try { return operation(); }
    catch (e) {
      if (e instanceof RangeError) throw error('RangeError', e.message);
      if (e instanceof TypeError) throw error('TypeError', e.message);
      throw e;
    }
  };
  const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const dictionary = value => {
    if (value != null && !isObject(value)) throw error('TypeError', 'Options must be a dictionary');
    return value;
  };
  const decoderOf = value => {
    const decoder = decoders.get(value);
    if (!decoder) throw error('TypeError', 'Illegal invocation');
    return decoder;
  };
  const bufferSource = value => {
    if (value === undefined || ArrayBuffer.isView(value)) return;
    // Brand checks don't invoke user getters or accept a forged toStringTag.
    try { arrayBufferLength.call(value); return; } catch {}
    if (sharedBufferLength) {
      try { sharedBufferLength.call(value); return; } catch {}
    }
    throw error('TypeError', 'Input must be an ArrayBuffer or ArrayBufferView');
  };
  function TextDecoder(label = 'utf-8', options = undefined) {
    if (!new.target) throw error('TypeError', 'TextDecoder requires new');
    label = encodingString(label, error);
    dictionary(options);
    const fatal = Boolean(options?.fatal), ignoreBOM = Boolean(options?.ignoreBOM);
    decoders.set(this, native(() => new NativeDecoder(label, {fatal, ignoreBOM})));
  }
  Object.defineProperty(TextDecoder, 'prototype', {writable: false});
  for (const key of ['encoding', 'fatal', 'ignoreBOM']) {
    Object.defineProperty(TextDecoder.prototype, key, {
      get() { return decoderOf(this)[key]; }, enumerable: true, configurable: true,
    });
  }
  Object.defineProperty(TextDecoder.prototype, 'decode', {
    value: function decode(input = undefined, options = undefined) {
      const decoder = decoderOf(this);
      bufferSource(input);
      dictionary(options);
      const stream = Boolean(options?.stream);
      return native(() => decoder.decode(input, {stream}));
    }, writable: true, enumerable: true, configurable: true,
  });
  Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, {value: 'TextDecoder', configurable: true});
  return TextDecoder;
}

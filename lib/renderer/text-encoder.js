import {encodingString} from './encoding-string.js';

const NativeEncoder = globalThis.TextEncoder;
const encoders = new WeakMap();
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;

// Conversion runs outside the catch: only failures from the native codec are
// translated to the calling realm. Bun still performs all UTF-8 encoding.
export function textEncoderInterface(global = () => globalThis) {
  const error = (name, message) => new (global()[name])(message);
  const encoderOf = value => {
    const encoder = encoders.get(value);
    if (!encoder) throw error('TypeError', 'Illegal invocation');
    return encoder;
  };
  const native = operation => {
    try { return operation(); }
    catch (e) {
      if (e instanceof TypeError) throw error('TypeError', e.message);
      throw e;
    }
  };
  function TextEncoder() {
    if (!new.target) throw error('TypeError', 'TextEncoder requires new');
    encoders.set(this, new NativeEncoder());
  }
  Object.defineProperty(TextEncoder, 'prototype', {writable:false});
  Object.defineProperties(TextEncoder.prototype, {
    encoding: {get() { encoderOf(this); return 'utf-8'; }, enumerable:true, configurable:true},
    encode: {
      value: function encode(input = '') {
        const encoder = encoderOf(this);
        input = encodingString(input, error);
        return native(() => encoder.encode(input));
      }, writable:true, enumerable:true, configurable:true,
    },
    encodeInto: {
      value: function encodeInto(source, destination) {
        const encoder = encoderOf(this);
        if (arguments.length < 2) throw error('TypeError', 'encodeInto requires two arguments');
        source = encodingString(source, error);
        // The intrinsic getter checks internal slots, not a spoofable tag or
        // instanceof (which also rejects valid arrays from another realm).
        if (typedArrayTag.call(destination) !== 'Uint8Array')
          throw error('TypeError', 'Destination must be a Uint8Array');
        return native(() => encoder.encodeInto(source, destination));
      }, writable:true, enumerable:true, configurable:true,
    },
    [Symbol.toStringTag]: {value:'TextEncoder', configurable:true},
  });
  return TextEncoder;
}

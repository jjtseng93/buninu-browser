import {test, expect} from 'bun:test';
import {textDecoderInterface} from '../lib/renderer/text-decoder.js';

const errors = {TypeError: class PageTypeError extends TypeError {}, RangeError: class PageRangeError extends RangeError {}};
const Decoder = textDecoderInterface(() => errors);

test('TextDecoder translates native failures without rewriting user exceptions', () => {
  expect(() => new Decoder('bad-label')).toThrow(errors.RangeError);
  expect(() => new Decoder('utf-8', {fatal:true}).decode(new Uint8Array([255]))).toThrow(errors.TypeError);
  expect(() => Decoder()).toThrow(errors.TypeError);
  for (const value of [Symbol(), {[Symbol.toPrimitive]: () => Symbol()}, {toString: () => ({}), valueOf: () => ({})}])
    expect(() => new Decoder(value)).toThrow(errors.TypeError);
  for (const sentinel of [new TypeError('user error'), new RangeError('user error'), null, 42]) {
    const throws = () => { throw sentinel; };
    const actions = [
      () => new Decoder({toString: throws}),
      () => new Decoder({[Symbol.toPrimitive]: throws}),
      () => new Decoder('utf-8', {get fatal() { return throws(); }}),
      () => new Decoder().decode(undefined, {get stream() { return throws(); }}),
    ];
    for (const action of actions) {
      let caught = false;
      try { action(); } catch (error) { caught = true; expect(error).toBe(sentinel); }
      expect(caught).toBe(true);
    }
  }
});

test('TextDecoder preserves streaming state, BOM handling, buffers and subclasses', () => {
  const decoder = new Decoder();
  expect(decoder.decode(new Uint8Array([0xe6, 0xb0]), {stream:true})).toBe('');
  expect(decoder.decode(new Uint8Array([0xb4]))).toBe('水');
  expect(decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 65]))).toBe('A');
  expect(new Decoder('utf-8', {ignoreBOM:true}).decode(new Uint8Array([0xef, 0xbb, 0xbf, 65]))).toBe('\ufeffA');
  const bytes = new Uint8Array([88, 65, 89]);
  expect(decoder.decode(new DataView(bytes.buffer, 1, 1))).toBe('A');
  expect(decoder.decode(bytes.buffer)).toBe('XAY');
  class Derived extends Decoder {}
  const derived = new Derived();
  expect(derived).toBeInstanceOf(Derived);
  expect(derived.encoding).toBe('utf-8');
  const OtherDecoder = textDecoderInterface(() => errors);
  expect(OtherDecoder.prototype.decode.call(derived, bytes)).toBe('XAY');
  for (const fake of [{}, Object.create(Decoder.prototype), new Proxy(decoder, {})])
    expect(() => Decoder.prototype.decode.call(fake, bytes)).toThrow(errors.TypeError);
});

test('TextDecoder checks arguments in WebIDL order', () => {
  const calls = [];
  new Decoder({toString() { calls.push('label'); return 'utf8'; }}, {
    get fatal() { calls.push('fatal'); return false; },
    get ignoreBOM() { calls.push('ignoreBOM'); return false; },
  });
  expect(calls).toEqual(['label', 'fatal', 'ignoreBOM']);
  expect(() => new Decoder().decode({}, {get stream() { throw Error('must not run'); }})).toThrow(errors.TypeError);
  for (const options of [1, '', true, Symbol()]) {
    expect(() => new Decoder('utf-8', options)).toThrow(errors.TypeError);
    expect(() => new Decoder().decode(undefined, options)).toThrow(errors.TypeError);
  }
  expect(new Decoder('utf-8', null).decode(undefined, null)).toBe('');
});

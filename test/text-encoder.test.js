import {test, expect} from 'bun:test';
import {textEncoderInterface} from '../lib/renderer/text-encoder.js';

const errors = {TypeError: class PageTypeError extends TypeError {}};
const Encoder = textEncoderInterface(() => errors);

test('TextEncoder validates receivers and Uint8Array slots without invoking user code', () => {
  const encoder = new Encoder();
  expect(() => Encoder()).toThrow(errors.TypeError);
  for (const value of [null, undefined, {}, Object.create(Encoder.prototype), new Proxy(encoder, {})])
    expect(() => Encoder.prototype.encode.call(value, 'a')).toThrow(errors.TypeError);
  const fake = {get [Symbol.toStringTag]() { throw Error('must not read'); }};
  for (const destination of [null, undefined, 1, fake, new Uint8ClampedArray(2), new Int8Array(2),
    new ArrayBuffer(2), new DataView(new ArrayBuffer(2)), new Proxy(new Uint8Array(2), {})])
    expect(() => encoder.encodeInto('a', destination)).toThrow(errors.TypeError);
  expect(() => encoder.encodeInto()).toThrow(errors.TypeError);
  expect(() => encoder.encodeInto('a')).toThrow(errors.TypeError);
  expect(() => encoder.encode(Symbol())).toThrow(errors.TypeError);
});

test('TextEncoder converts once, preserves thrown values and ignores constructor arguments', () => {
  const sentinel = new TypeError('user');
  const source = {toString() { throw sentinel; }};
  expect(new Encoder(source).encoding).toBe('utf-8');
  for (const action of [() => new Encoder().encode(source), () => new Encoder().encodeInto(source, {})]) {
    let caught;
    try { action(); } catch (e) { caught = e; }
    expect(caught).toBe(sentinel);
  }
  let count = 0;
  const destination = new Uint8Array(10);
  expect(new Encoder().encodeInto({toString() { count++; return '水'; }}, destination)).toEqual({read:1, written:3});
  expect(count).toBe(1);
  expect([...destination.slice(0, 3)]).toEqual([0xe6, 0xb0, 0xb4]);
});

test('TextEncoder preserves native UTF-8 boundaries, shared and detached buffers', () => {
  const encoder = new Encoder();
  expect([...encoder.encode()]).toEqual([]);
  expect([...encoder.encode(undefined)]).toEqual([]);
  expect([...encoder.encode('\ud800')]).toEqual([239, 191, 189]);
  expect(encoder.encodeInto('😀', new Uint8Array(3))).toEqual({read:0, written:0});
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  expect(encoder.encodeInto('😀', shared)).toEqual({read:2, written:4});
  const view = new Uint8Array(4);
  view.buffer.transfer();
  expect(encoder.encodeInto('a', view)).toEqual({read:0, written:0});
  class Derived extends Encoder {}
  const borrowed = textEncoderInterface(() => errors).prototype.encode;
  expect([...borrowed.call(new Derived(), 'A')]).toEqual([65]);
});

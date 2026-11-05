import {test, expect} from 'bun:test';
import {progressEventInterface} from '../lib/renderer/progress-event.js';

const errors = {TypeError:class PageTypeError extends TypeError {}};
const ProgressEvent = progressEventInterface(Event, () => errors);

test('ProgressEvent preserves Event dispatch and double-valued progress', () => {
  class Derived extends ProgressEvent {}
  const event = new Derived('progress', {loaded:-1.5, total:3.5, lengthComputable:true, cancelable:true});
  expect(event).toBeInstanceOf(Derived);
  expect(event).toBeInstanceOf(Event);
  expect(event.loaded).toBe(-1.5);
  expect(event.total).toBe(3.5);
  const target = new EventTarget();
  let received;
  target.addEventListener('progress', e => { received=e; e.preventDefault(); });
  expect(target.dispatchEvent(event)).toBe(false);
  expect(received).toBe(event);
  const getter = Object.getOwnPropertyDescriptor(ProgressEvent.prototype, 'loaded').get;
  expect(() => getter.call({})).toThrow(errors.TypeError);
});

test('ProgressEvent converts dictionary fields in order and preserves user exceptions', () => {
  const seen=[];
  new ProgressEvent({toString() { seen.push('type'); return 'x'; }}, {
    get bubbles() { seen.push('bubbles'); return false; },
    get cancelable() { seen.push('cancelable'); return false; },
    get composed() { seen.push('composed'); return false; },
    get lengthComputable() { seen.push('lengthComputable'); return false; },
    get loaded() { seen.push('loaded'); return {valueOf() { seen.push('number'); return 1; }}; },
    get total() { seen.push('total'); return 2; },
  });
  expect(seen).toEqual(['type','bubbles','cancelable','composed','lengthComputable','loaded','number','total']);
  const sentinel = new TypeError('user');
  let caught;
  try { new ProgressEvent('x', {loaded:{valueOf() {throw sentinel;}}}); } catch(e) {caught=e;}
  expect(caught).toBe(sentinel);
  for (const value of [NaN, Infinity, -Infinity, Symbol(), 1n])
    expect(() => new ProgressEvent('x', {loaded:value})).toThrow(errors.TypeError);
  expect(() => new ProgressEvent()).toThrow(errors.TypeError);
  expect(() => ProgressEvent('x')).toThrow(errors.TypeError);
});

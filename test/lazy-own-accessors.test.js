import {test, expect} from 'bun:test';
import {lazyOwnAccessors} from '../lib/renderer/lazy-own-accessors.js';

function fixture(lazy) {
  const values = new WeakMap();
  const target = {before:1};
  const descriptors = {
    color:{enumerable:true, configurable:true, get(){return values.get(this);}, set(){throw new TypeError('readonly');}},
    width:{enumerable:true, configurable:true, get(){return '10px';}},
  };
  const object = lazy ? lazyOwnAccessors(target,descriptors) : Object.defineProperties(target,descriptors);
  values.set(object,'red');
  return {object,target,values,descriptors};
}
test('ordinary accessor reads stay lazy and use the public receiver',()=>{
  const {object,target,values}=fixture(true);
  expect(object.color).toBe('red');
  expect('width' in object).toBe(true);
  expect(Object.keys(target)).toEqual(['before']);
  values.set(object,'blue');expect(object.color).toBe('blue');
  expect(()=>{object.color='green';}).toThrow('readonly');
  expect(Object.keys(target)).toEqual(['before']);
});
test('reflection, deletion, overrides and sealing preserve eager descriptor semantics',()=>{
  for(const lazy of [false,true]) {
    const {object}=fixture(lazy);
    expect(Reflect.ownKeys(object)).toEqual(['before','color','width']);
    const d=Object.getOwnPropertyDescriptor(object,'color');
    expect(d.get.call(object)).toBe('red');
    expect(d.enumerable).toBe(true);expect(d.configurable).toBe(true);
    delete object.color;expect('color' in object).toBe(false);
    object.extra=3;Object.defineProperty(object,'width',{value:'20px'});
    expect(object.width).toBe('20px');expect(object.extra).toBe(3);
    Object.freeze(object);expect(Object.isFrozen(object)).toBe(true);
  }
});
test('preventExtensions materializes unread accessors and preserves own-key order',()=>{
  const {object}=fixture(true);
  Object.preventExtensions(object);
  expect(Reflect.ownKeys(object)).toEqual(['before','color','width']);
  expect(object.color).toBe('red');
  expect(Reflect.set(object,'extra',1)).toBe(false);
});

import {expect, test} from 'bun:test';
import {platformObject} from '../lib/renderer/interfaces.js';
import {permissionName} from '../lib/renderer/permission-descriptor.js';

test('Web IDL promise operations reject receiver and conversion failures', async()=>{
  const sentinel = Error('conversion failed');
  const made = platformObject('AsyncTest', {
    query(descriptor) { return permissionName(descriptor); },
    ordinary() { return 1; },
    get value() { return 1; },
  }, {promiseOperations:['query']});
  const query = made.prototype.query;
  let reads = 0;
  const descriptor = {get name(){reads++;return 'notifications';}};
  const rejected = query.call({}, descriptor);
  expect(rejected).toBeInstanceOf(Promise);
  await expect(rejected).rejects.toBeInstanceOf(TypeError);
  expect(reads).toBe(0);
  await expect(query.call(null, {})).rejects.toBeInstanceOf(TypeError);
  await expect(query.call(made.instance, {get name(){throw sentinel;}})).rejects.toBe(sentinel);
  await expect(query.call(made.instance, {})).rejects.toBeInstanceOf(TypeError);
  await expect(query.call(made.instance, {name:'not-a-permission'})).rejects.toBeInstanceOf(TypeError);
  await expect(query.call(made.instance, descriptor)).resolves.toBe('notifications');
  expect(reads).toBe(1);
  expect(query.length).toBe(1);
  expect(()=>new query()).toThrow(TypeError);
  expect(()=>made.prototype.ordinary.call({})).toThrow(TypeError);
  expect(()=>Object.getOwnPropertyDescriptor(made.prototype,'value').get.call({})).toThrow(TypeError);
});

test('permission dictionary reads and string conversion happen once, including callable dictionaries',()=>{
  const seen=[];
  const descriptor={get name(){seen.push('name');return {[Symbol.toPrimitive](hint){seen.push(hint);return 'notifications';}};}};
  expect(permissionName(descriptor)).toBe('notifications');
  expect(seen).toEqual(['name','string']);
  const callable=function(){};
  Object.defineProperty(callable,'name',{value:'geolocation'});
  expect(permissionName(callable)).toBe('geolocation');
  for(const bad of [null,undefined,4,'notifications',{}, {name:undefined},{name:Symbol('notifications')},{name:{[Symbol.toPrimitive](){return Symbol();}}},{name:'not-a-permission'}]){
    expect(()=>permissionName(bad)).toThrow(TypeError);
  }
});

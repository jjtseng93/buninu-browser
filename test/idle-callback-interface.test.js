import {test, expect} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {createIdleCallbackInterface} from '../lib/renderer/idle-callback-interface.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture() {
  const global = runInNewContext('({TypeError, Function, Object})'), calls = [];
  const idle = createIdleCallbackInterface({request:(fn, timeout) => {calls.push([fn, timeout]); return calls.length;}, cancel:id => calls.push(id)});
  idle.initialize(global);
  Object.assign(global, idle.api);
  return {global, calls, idle};
}

test('IdleDeadline has branded prototype operations and uses the originating clock across realms', () => {
  const a=fixture(),b=fixture();let remaining=10;
  const value=a.idle.wrap({didTimeout:false,timeRemaining:()=>remaining});
  expect(Object.prototype.toString.call(value)).toBe('[object IdleDeadline]');
  expect(value instanceof a.global.IdleDeadline).toBeTrue();
  expect(Object.keys(value)).toEqual([]);
  expect(value.timeRemaining()).toBe(10);
  remaining=3;
  expect(b.global.IdleDeadline.prototype.timeRemaining.call(value)).toBe(3);
  const get=Object.getOwnPropertyDescriptor(b.global.IdleDeadline.prototype,'didTimeout').get;
  expect(get.call(value)).toBeFalse();
  for(const bad of [{},null,undefined,Object.create(a.global.IdleDeadline.prototype),new Proxy(value,{})]) {
    expect(()=>b.global.IdleDeadline.prototype.timeRemaining.call(bad)).toThrow(b.global.TypeError);
    expect(()=>get.call(bad)).toThrow(b.global.TypeError);
  }
  expect(()=>new a.global.IdleDeadline()).toThrow(a.global.TypeError);
  expect(()=>a.global.IdleDeadline()).toThrow(a.global.TypeError);
  expect(()=>new a.global.IdleDeadline.prototype.timeRemaining()).toThrow();
  expect(Object.getOwnPropertyDescriptor(a.global.IdleDeadline,'prototype').writable).toBeFalse();
  expect(Object.getPrototypeOf(a.global.IdleDeadline)).toBe(a.global.Function.prototype);
  expect(Object.getPrototypeOf(a.global.IdleDeadline.prototype)).toBe(a.global.Object.prototype);
});

test('idle Window operations validate receivers and unsigned longs before scheduling', () => {
  const a=fixture(), b=fixture(), callback=()=>{};
  expect(a.global.requestIdleCallback.length).toBe(1);
  expect(a.global.cancelIdleCallback.length).toBe(1);
  expect(a.global.requestIdleCallback(callback,{timeout:4294967297})).toBe(1);
  expect(a.calls[0]).toEqual([callback,1]);
  a.global.cancelIdleCallback(4294967297);expect(a.calls[1]).toBe(1);
  a.global.requestIdleCallback.call(b.global,callback,{timeout:-1});
  expect(b.calls[0]).toEqual([callback,4294967295]);
  a.global.cancelIdleCallback.call(b.global,NaN);expect(b.calls[1]).toBe(0);
  a.global.requestIdleCallback.call(null,callback);expect(a.calls[2]).toEqual([callback,0]);
  let read=false;
  expect(()=>a.global.requestIdleCallback.call({},callback,{get timeout(){read=true;}})).toThrow(a.global.TypeError);
  expect(read).toBeFalse();
  for(const args of [[],[null],[callback,1],[callback,{timeout:1n}],[callback,{timeout:Object(1n)}],[callback,{timeout:Symbol()}]])
    expect(()=>a.global.requestIdleCallback.apply(a.global,args)).toThrow(a.global.TypeError);
  expect(()=>a.global.cancelIdleCallback()).toThrow(a.global.TypeError);
  expect(()=>a.global.cancelIdleCallback(1n)).toThrow(a.global.TypeError);
  const marker={};let caught;
  try {a.global.requestIdleCallback(callback,{timeout:{valueOf(){throw marker;}}});}catch(e){caught=e;}
  expect(caught).toBe(marker);
  const saved=a.global.TypeError;a.global.TypeError=function(){throw 'replaced';};
  expect(()=>a.global.requestIdleCallback(null)).toThrow(saved);
});

test('page idle callbacks expose page-realm brands, errors and ordinary callback arguments', async () => {
  const host=new RendererHost();
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://idle-interface.test/',contentType:'text/html',source:'<!doctype html><p>Idle deadline</p>'});
    await host.call('whenLoaded');
    const result=await host.call('evaluate',`new Promise(resolve=>{
      const errors=[];
      for(const f of [()=>new IdleDeadline(),()=>requestIdleCallback(),()=>cancelIdleCallback(),()=>requestIdleCallback.call({},()=>{}),()=>cancelIdleCallback.call({},1),()=>requestIdleCallback(()=>{},{timeout:1n})])
        try{f();errors.push(false)}catch(e){errors.push(e instanceof TypeError)};
      requestIdleCallback(function(deadline){
        resolve({errors,tag:Object.prototype.toString.call(deadline),instance:deadline instanceof IdleDeadline,keys:Object.keys(deadline),argc:arguments.length,receiver:this===window,remaining:deadline.timeRemaining(),timeout:deadline.didTimeout});
      });
    })`);
    expect(result.errors).toEqual([true,true,true,true,true,true]);
    expect(result.tag).toBe('[object IdleDeadline]');expect(result.instance).toBeTrue();
    expect(result.keys).toEqual([]);expect(result.argc).toBe(1);expect(result.receiver).toBeTrue();
    expect(result.remaining).toBeGreaterThanOrEqual(0);expect(result.remaining).toBeLessThanOrEqual(10);expect(result.timeout).toBeFalse();
  } finally {host.close();}
},30000);

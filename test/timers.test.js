import { expect, test } from 'bun:test';
import { createTimers } from '../lib/renderer/timers.js';
function fixture() {
  let id=0, handle=0;
  const pending=new Map(), tasks=new Map(), delays=[], errors=[];
  const timers=createTimers({nextId:()=>++id, invoke(fn){try{fn();}catch(error){errors.push(error.message);}},
    setTimer(callback,delay){delays.push(delay);pending.set(++handle,callback);return handle;},
    clearTimer(handle){pending.delete(handle);},
    queueTask(callback){tasks.set(++handle,callback);return handle;},clearTask(handle){tasks.delete(handle);}});
  const fire=()=>{const [handle,callback]=pending.entries().next().value;pending.delete(handle);callback();};
  const checkpoint=()=>{for(const [handle,callback] of [...tasks]){tasks.delete(handle);callback();}};
  return {timers,pending,tasks,delays,errors,fire,checkpoint};
}
test('timer delay is converted once to a Web IDL long before repeats',()=>{
  const f=fixture();let conversions=0,calls=0,id;
  id=f.timers.schedule(()=>{if(++calls===9)f.timers.cancel(id);},{valueOf(){conversions++;return 0;}},true);
  for(let i=0;i<9;i++){f.fire();f.checkpoint();}
  expect(conversions).toBe(1);expect(calls).toBe(9);
  expect(f.delays).toEqual([0,0,0,0,0,0,4,4,4,4]);
  expect(f.pending.size).toBe(0);f.timers.dispose();expect(f.tasks.size).toBe(0);
});
test('nested timeout, Promise chains and queueMicrotask share timer nesting',async()=>{
  for(const defer of [fn=>fn(),fn=>Promise.resolve().then(fn),fn=>Promise.resolve().then(()=>{}).then(()=>{}).then(fn),fn=>queueMicrotask(fn)]){
    const f=fixture();let count=0;
    const step=()=>{if(++count<9)defer(()=>f.timers.schedule(step,0));};
    f.timers.schedule(step,0);
    for(let i=0;i<9;i++){f.fire();for(let n=0;n<5;n++)await Promise.resolve();f.checkpoint();}
    expect(f.delays).toEqual([0,0,0,0,0,0,4,4,4]);f.timers.dispose();
  }
});
test('a later task or deferred promise cannot inherit a finished timer task',async()=>{
  const f=fixture();let count=0,resolveLate;
  const step=()=>{if(++count<7)f.timers.schedule(step,0);else{
    Promise.resolve().then(()=>f.timers.schedule(()=>{},0));
    new Promise(resolve=>resolveLate=resolve).then(()=>f.timers.schedule(()=>{},0));
  }};
  f.timers.schedule(step,0);
  for(let i=0;i<7;i++){f.fire();await Promise.resolve();f.checkpoint();}
  expect(f.delays.at(-1)).toBe(4);
  resolveLate();await Promise.resolve();expect(f.delays.at(-1)).toBe(0);
  f.timers.schedule(()=>{},0);expect(f.delays.at(-1)).toBe(0);f.timers.dispose();
});
test('signed delay conversion rejects invalid conversions synchronously without queuing',()=>{
  const f=fixture();for(const value of [undefined,-1,Infinity,NaN,2147483648,4294967296])f.timers.schedule(()=>{},value);
  f.timers.schedule(()=>{},4294967301);f.timers.schedule(()=>{},2.9);
  expect(f.delays).toEqual([0,0,0,0,0,0,5,2]);
  expect(()=>f.timers.schedule(()=>{},1n)).toThrow(TypeError);
  expect(()=>f.timers.schedule(()=>{},Symbol())).toThrow(TypeError);
  expect(()=>f.timers.schedule(()=>{},{valueOf(){throw Error('delay failure');}})).toThrow('delay failure');
  expect(f.delays).toHaveLength(8);f.timers.dispose();
});
test('cancel inside callback, exceptions and disposal keep one live repeat and no late tasks',()=>{
  const f=fixture();let calls=0,id=f.timers.schedule(()=>{calls++;if(calls===1)throw Error('tick');else f.timers.cancel(id);},1,true);
  f.fire();expect(f.pending.size).toBe(1);f.checkpoint();f.fire();expect(f.pending.size).toBe(0);expect(f.errors).toEqual(['tick']);
  const never=f.timers.schedule(()=>{throw Error('canceled');},0);f.timers.cancel(never);expect(f.pending.size).toBe(0);
  f.timers.schedule(()=>f.timers.dispose(),0,true);f.fire();expect(f.pending.size).toBe(0);expect(f.tasks.size).toBe(0);
  f.timers.schedule(()=>{throw Error('disposed');},0);expect(f.pending.size).toBe(0);
});

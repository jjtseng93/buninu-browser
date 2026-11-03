import {test,expect} from 'bun:test';
import {createPerformanceClock} from '../lib/renderer/coarse-performance-clock.js';
test('monotonic sub-tick reads coalesce while elapsed real time advances',()=>{
 let now=12.345;const clock=createPerformanceClock({now:()=>now,timeOrigin:1000});
 expect(clock.offset).toBe(12.3);expect(clock.timeOrigin).toBe(1012.3);
 const values=[12.345,12.39,12.4,12.49,12.5,1012.34].map(v=>{now=v;return clock.now();});
 expect(values).toEqual([0,0,.1,.1,.2,1000]);
});
test('document origins differ while their epoch-relative readings agree',()=>{
 let now=100.04;const host={now:()=>now,timeOrigin:1600000000000.123};
 const a=createPerformanceClock(host);now=105.29;const b=createPerformanceClock(host);now=110.85;
 expect(a.timeOrigin).toBeLessThan(b.timeOrigin);
 expect(a.timeOrigin+a.now()).toBeCloseTo(b.timeOrigin+b.now(),3);
 const origin=a.timeOrigin;host.timeOrigin+=60000;now+=100;
 expect(a.timeOrigin).toBe(origin);expect(a.now()).toBeCloseTo(110.8,6);
});

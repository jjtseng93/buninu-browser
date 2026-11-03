import {test,expect} from 'bun:test';
import {platformObject} from '../lib/renderer/interfaces.js';
test('borrowed WebIDL accessors and methods use actual receiver state across realms',async()=>{
 const make=(value)=>platformObject('CrossRealmTest',{value,nullable:value===1?null:undefined,
  get dynamic(){return value+this.offset;},set dynamic(v){this.offset=v-value;},read(){return value+this.offset;},
  async query(){return value+this.offset;}},{promiseOperations:['query']});
 const a=make(1),b=make(10);const x=a.create({offset:2}),y=b.create({offset:3});
 expect(Object.getOwnPropertyDescriptor(a.prototype,'value').get.call(y)).toBe(10);
 expect(Object.getOwnPropertyDescriptor(b.prototype,'nullable').get.call(x)).toBe(null);
 expect(Object.getOwnPropertyDescriptor(a.prototype,'nullable').get.call(y)).toBe(undefined);
 const d=Object.getOwnPropertyDescriptor(a.prototype,'dynamic');
 expect(d.get.call(y)).toBe(13);d.set.call(y,20);expect(b.prototype.read.call(y)).toBe(20);
 expect(a.prototype.read.call(y)).toBe(20);expect(a.prototype.read.call(x)).toBe(3);
 await expect(a.prototype.query.call(y)).resolves.toBe(20);
 Object.defineProperty(b.prototype,'read',{value:()=>999});
 expect(a.prototype.read.call(y)).toBe(20);
 for(const forged of [{},Object.create(b.prototype),new Proxy(y,{})]){
  expect(()=>d.get.call(forged)).toThrow(TypeError);
  expect(()=>a.prototype.read.call(forged)).toThrow(TypeError);
  await expect(a.prototype.query.call(forged)).rejects.toBeInstanceOf(TypeError);
 }
 const other=platformObject('OtherRealmTest',{read(){return 4;}});
 expect(()=>a.prototype.read.call(other.instance)).toThrow(TypeError);
});

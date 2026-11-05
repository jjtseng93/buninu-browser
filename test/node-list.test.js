import {test,expect} from 'bun:test';
import {nodeListInterface} from '../lib/renderer/node-list.js';

test('NodeList indexed properties use real length while ordinary length can be shadowed', () => {
  const {NodeList,create}=nodeListInterface();
  const nodes=[{},{}], list=create(nodes,n=>n);
  expect(list).toBeInstanceOf(NodeList);expect(Array.isArray(list)).toBe(false);
  expect(Object.keys(list)).toEqual(['0','1']);expect(list.map).toBeUndefined();
  expect(list.item(2)).toBeNull();expect(list.namedItem).toBeUndefined();
  expect(Reflect.set(list,'0',3)).toBe(false);expect(Reflect.deleteProperty(list,'9')).toBe(true);
  Object.defineProperty(list,'length',{value:1,configurable:true});
  expect([...list]).toEqual([nodes[0]]);
  expect(list[1]).toBe(nodes[1]);expect(list.item(1)).toBe(nodes[1]);
  delete list.length;nodes.push({});expect([...list]).toEqual(nodes);
  expect(Reflect.preventExtensions(list)).toBe(false);
});

test('NodeList iterators stay live and borrowed methods validate receivers', () => {
  const first=nodeListInterface(), second=nodeListInterface();
  const nodes=[{id:1},{id:2}],list=first.create(()=>nodes,n=>n);
  const iter=list.entries();expect(iter.next().value).toEqual([0,nodes[0]]);
  nodes.push({id:3});expect([...iter]).toEqual([[1,nodes[1]],[2,nodes[2]]]);
  expect(second.NodeList.prototype.item.call(list,0)).toBe(nodes[0]);
  expect(()=>first.NodeList.prototype.item.call({})).toThrow(TypeError);
  const child=Object.create(list);expect(()=>child.length).toThrow(TypeError);
  const seen=[];list.forEach((node,index,self)=>seen.push([node,index,self===list]));
  expect(seen).toEqual(nodes.map((node,index)=>[node,index,true]));
});

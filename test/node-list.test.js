import {test,expect} from 'bun:test';
import {nodeListInterface} from '../lib/renderer/node-list.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm} from '../lib/renderer/bindings.js';

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

test('static NodeList wraps only accessed indices and reuses their identities', () => {
  const {create}=nodeListInterface(), nodes=[{id:1},{id:2},{id:3}], wrapped=[];
  const list=create(nodes,node=>{wrapped.push(node);return {node};},{static:true});
  expect(wrapped).toEqual([]);
  expect(list.length).toBe(3);expect(1 in list).toBe(true);
  expect(Reflect.ownKeys(list)).toEqual(['0','1','2']);expect(wrapped).toEqual([]);
  const second=list[1];
  expect(list[1]).toBe(second);expect(list.item(1)).toBe(second);
  expect(Object.getOwnPropertyDescriptor(list,'1').value).toBe(second);
  expect(wrapped).toEqual([nodes[1]]);
  expect(list[9]).toBeUndefined();expect(list.item(9)).toBeNull();
  expect(wrapped).toEqual([nodes[1]]);
  expect(list[0].node).toBe(nodes[0]);expect(wrapped).toEqual([nodes[1],nodes[0]]);
});

test('static NodeList length remains overridable on the instance and its prototypes', () => {
  for(const mode of ['own','replacement','interface']) {
    const {create,NodeList}=nodeListInterface(), nodes=[{id:1},{id:2}];
    const list=create(nodes,node=>node,{static:true}), iterator=NodeList.prototype.values;
    const object=mode==='own'?list:mode==='interface'?NodeList.prototype:Object.create(NodeList.prototype);
    Object.defineProperty(object,'length',{get(){return 1;},configurable:true});
    if(mode==='replacement')Object.setPrototypeOf(list,object);
    expect(list.length).toBe(1);expect([...iterator.call(list)]).toEqual([nodes[0]]);
    expect(list[1]).toBe(nodes[1]);expect(NodeList.prototype.item.call(list,1)).toBe(nodes[1]);
    expect(Object.keys(list)).toEqual(['0','1']);
  }
});

test('live NodeList reads changed indices and evaluates query sources once per lookup', () => {
  const {create}=nodeListInterface(), nodes=[{id:1},{id:2}], replacement={id:3};
  let queries=0;
  const direct=create(nodes,node=>node), queried=create(()=>{queries++;return nodes;},node=>node);
  expect(queried[0]).toBe(nodes[0]);expect(queries).toBe(1);
  Object.getOwnPropertyDescriptor(queried,'0');expect(queries).toBe(2);
  expect(queried.item(0)).toBe(nodes[0]);expect(queries).toBe(3);
  for(const list of [direct,queried])expect(list[0]).toBe(nodes[0]);
  nodes.shift();
  for(const list of [direct,queried])expect(list[0]).toBe(nodes[0]);
  nodes[0]=replacement;nodes.push({id:4});
  for(const list of [direct,queried]) {
    expect(list[0]).toBe(replacement);expect(list.length).toBe(2);expect([...list]).toEqual(nodes);
  }
});

test('indexed traps preserve canonical index boundaries and prototype fallbacks', () => {
  const {create,NodeList}=nodeListInterface(), first={}, list=create([first],node=>node,{static:true});
  for(const key of ['', '-0','00','01','1.0','1e0',' 0','0 ','0\n','1\n','4294967295',Symbol('index')]) {
    expect(Reflect.set(list,key,'expando')).toBe(true);expect(list[key]).toBe('expando');
    expect(Reflect.deleteProperty(list,key)).toBe(true);
  }
  expect(Reflect.set(list,'0',{})).toBe(false);expect(Reflect.deleteProperty(list,'0')).toBe(false);
  expect(Reflect.defineProperty(list,'4294967294',{value:'index'})).toBe(false);
  NodeList.prototype[1]='inherited';
  expect(list[0]).toBe(first);expect(list[1]).toBe('inherited');expect(1 in list).toBe(true);
  expect(Object.hasOwn(list,'1')).toBe(false);expect(Reflect.deleteProperty(list,'1')).toBe(true);
});

test('BindingRealm static snapshots keep their nodes after DOM reordering and removal', () => {
  const {window}=parseHTMLDocument('<div><i></i><b></b></div>');
  try {
    const realm=new BindingRealm(window,{});realm.nodeLists=nodeListInterface();
    const root=window.document.querySelector('div'), first=root.firstChild, second=root.lastChild;
    const list=realm.staticList(root.childNodes), live=realm.live(root.childNodes), wrapper=list[0];
    expect(wrapper).toBe(realm.wrap(first));expect(list[1]).toBe(realm.wrap(second));
    root.appendChild(first);second.remove();
    expect(list.length).toBe(2);expect(list[0]).toBe(wrapper);expect(list[1]).toBe(realm.wrap(second));
    expect(live.length).toBe(1);expect(live[0]).toBe(wrapper);expect(live[1]).toBeUndefined();
  } finally {window.happyDOM.close();}
});

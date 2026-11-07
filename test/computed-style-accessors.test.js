import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({timeout:20_000});
  await renderer.start();
});
afterAll(() => renderer?.close());
async function evaluate(source) {
  await renderer.call('loadDocument', {url:'https://computed.test/', contentType:'text/html', status:200,
    source:'<!doctype html><div id="one" style="width:100px;color:red;background-color:blue;--tone:first"></div><div id="two" style="width:200px;color:green;background-color:red"></div>'});
  await renderer.call('whenLoaded');
  return renderer.call('evaluate', `(() => {
    const one=document.getElementById('one'),two=document.getElementById('two');
    const a=getComputedStyle(one),b=getComputedStyle(two);
    ${source}
  })()`);
}

test('computed declarations preserve their own property order and accessor descriptors', async () => {
  expect(await evaluate(`
    const css=Array.from({length:a.length},(_,i)=>a.item(i));
    const idl=css.map(name=>name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()));
    const base=['length','item','getPropertyValue','getPropertyPriority','cssText','parentRule','setProperty','removeProperty'];
    const first=[...base,...idl,'webkitLineClamp','webkitBoxOrient'];
    const expected=[...first,...css.filter(name=>!first.includes(name))];
    const descriptors=Object.getOwnPropertyDescriptors(a);
    const named=expected.slice(base.length);
    return {order:JSON.stringify(Reflect.ownKeys(a))===JSON.stringify(expected),
      enumerable:JSON.stringify(Object.keys(a))===JSON.stringify(expected),
      aliases:['backgroundColor','background-color','WebkitLineClamp','webkitLineClamp','-webkit-line-clamp'].every(name=>Object.hasOwn(a,name)),
      flags:named.every(name=>descriptors[name].enumerable&&descriptors[name].configurable
        &&typeof descriptors[name].get==='function'&&typeof descriptors[name].set==='function'
        &&!('value' in descriptors[name])&&!('writable' in descriptors[name])),
      prototype:Object.getPrototypeOf(a)===Object.prototype,
      independent:a!==b};
  `)).toEqual({order:true, enumerable:true, aliases:true, flags:true, prototype:true, independent:true});
});

test('shared computed getters use the declaration receiver and remain live after detach and reattach', async () => {
  expect(await evaluate(`
    const color=Object.getOwnPropertyDescriptor(a,'color').get;
    const background=Object.getOwnPropertyDescriptor(a,'background-color').get;
    const width=Object.getOwnPropertyDescriptor(a,'width').get;
    const shared=color===Object.getOwnPropertyDescriptor(b,'color').get;
    const initial=[color.call(a),color.call(b),background.call(b),width.call(b)];
    two.style.color='blue';two.style.width='240px';
    const changed=[color.call(b),width.call(b),Reflect.get(a,'color',b)];
    two.remove();const detached=[color.call(b),width.call(b)];
    document.body.appendChild(two);const attached=[color.call(b),width.call(b)];
    return {shared,initial,changed,detached,attached,original:color.call(a)};
  `)).toEqual({shared:true, initial:['rgb(255, 0, 0)','rgb(0, 128, 0)','rgb(255, 0, 0)','200px'],
    changed:['rgb(0, 0, 255)','240px','rgb(0, 0, 255)'], detached:['',''],
    attached:['rgb(0, 0, 255)','240px'], original:'rgb(255, 0, 0)'});
});

test('computed named accessors reject receivers without declaration state', async () => {
  expect(await evaluate(`
    const read=Object.getOwnPropertyDescriptor(a,'color').get;
    const receivers=[undefined,null,true,42,'x',Symbol('x'),1n,{},one,Object.create(a)];
    const errors=receivers.map(receiver=>{
      try {read.call(receiver);return 'accepted'} catch(error) {return error.name}
    });
    let detached;try {read();detached='accepted'} catch(error) {detached=error.name}
    return {errors,detached,readable:a.color};
  `)).toEqual({errors:Array(10).fill('TypeError'), detached:'TypeError', readable:'rgb(255, 0, 0)'});
});

test('computed setters reject writes while local descriptor overrides and expandos remain independent', async () => {
  expect(await evaluate(`
    const setter=Object.getOwnPropertyDescriptor(a,'color').set;
    const error=action=>{try {action();return 'accepted'} catch(e) {return e.name}};
    const writes=[()=>setter.call(a,'blue'),()=>setter.call(b,'blue'),()=>a.color='blue',
      ()=>a['background-color']='green',()=>a.cssText='',()=>a.setProperty('--tone','changed'),()=>a.removeProperty('color')];
    const errors=writes.map(error);
    delete a.color;errors.push(error(()=>a.color='blue'));
    Object.defineProperty(a,'color',{value:'local',writable:true,enumerable:true,configurable:true});
    a.color='changed local';a.extra=42;
    return {errors,local:a.color,other:b.color,inline:one.style.color,extra:a.extra,otherExtra:b.extra??null,
      custom:a.getPropertyValue('--tone'),shared:setter===Object.getOwnPropertyDescriptor(b,'color').set};
  `)).toEqual({errors:Array(8).fill('NoModificationAllowedError'), local:'changed local',
    other:'rgb(0, 128, 0)', inline:'red', extra:42, otherExtra:null, custom:'first', shared:true});
});

test('shared computed accessor functions cannot carry page data into another document realm', async () => {
  expect(await evaluate(`
    const {get,set}=Object.getOwnPropertyDescriptor(a,'color');
    return [get,set].map(fn=>{
      const result={frozen:Object.isFrozen(fn),prototype:Object.hasOwn(fn,'prototype'),
        assigned:Reflect.set(fn,'__computedCrossRealm','secret')};
      try {Object.defineProperty(fn,'__computedCrossRealm',{value:{secret:one}});result.defined=true}
      catch(error) {result.defined=error.name}
      return result;
    });
  `)).toEqual(Array.from({length:2},()=>({frozen:true,prototype:false,assigned:false,defined:'TypeError'})));
  await renderer.call('loadDocument', {url:'https://another-computed.test/', contentType:'text/html', status:200,
    source:'<!doctype html><div style="color:blue"></div>'});
  await renderer.call('whenLoaded');
  expect(await renderer.call('evaluate', `(() => {
    const declaration=getComputedStyle(document.querySelector('div'));
    const {get,set}=Object.getOwnPropertyDescriptor(declaration,'color');
    return {clean:[get,set].every(fn=>!Object.hasOwn(fn,'__computedCrossRealm')&&Object.isFrozen(fn)
      &&!Object.hasOwn(fn,'prototype')),value:declaration.color};
  })()`)).toEqual({clean:true,value:'rgb(0, 0, 255)'});
});

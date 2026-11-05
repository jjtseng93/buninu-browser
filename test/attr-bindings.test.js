import {beforeAll, afterAll, test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({timeout:20000});
  await renderer.start();
  await renderer.call('loadDocument', {url:'https://page.test/',contentType:'text/html',source:'<!doctype html><p>Attributes</p>'});
  await renderer.call('whenLoaded');
});
afterAll(() => renderer?.close());
const evaluate = source => renderer.call('evaluate', source);

test('Attr retains Node identity through updates, replacement and detachment', async () => {
  expect(await evaluate(`(() => {
    const e=document.createElement('div'), a=document.createAttribute('DATA-Test');
    a.value='one'; e.setAttributeNode(a);
    const same=[a instanceof Attr,a instanceof Node,a.ownerDocument===document,
      a.ownerElement===e,a===e.attributes[0],a===e.getAttributeNode('data-test')];
    e.setAttribute('data-test','two');
    same.push(a.value==='two',e.getAttributeNode('data-test')===a);
    const b=document.createAttribute('data-test'); b.value='three';
    same.push(e.setAttributeNode(b)===a,a.ownerElement===null);
    a.value='detached'; same.push(e.getAttribute('data-test')==='three');
    same.push(e.removeAttributeNode(b)===b,b.ownerElement===null,b.parentNode===null);
    return same;
  })()`)).toEqual(Array(14).fill(true));
});

test('Attr value writes notify DOM observers and update styles without replacing the Attr', async () => {
  expect(await evaluate(`(() => {
    const e=document.createElement('div');document.body.append(e);e.setAttribute('style','color:red');
    const a=e.getAttributeNode('style'),o=new MutationObserver(()=>{});o.observe(e,{attributes:true,attributeOldValue:true});
    a.textContent='color:green';
    const records=o.takeRecords(); o.disconnect();
    const answer=[e.getAttributeNode('style')===a, records.length,records[0].oldValue,
      getComputedStyle(e).color]; e.remove();return answer;
  })()`)).toEqual([true,1,'color:red','rgb(0, 128, 0)']);
});

test('NamedNodeMap preserves duplicate qualified names across namespaces and method names', async () => {
  expect(await evaluate(`(() => {
    const e=document.createElement('div'),map=e.attributes;
    const a=document.createAttributeNS('urn:a','item'),b=document.createAttributeNS('urn:b','item');
    a.value='a';b.value='b';map.setNamedItem(a);map.setNamedItemNS(b);
    return [map instanceof NamedNodeMap,map===e.attributes,map.item===NamedNodeMap.prototype.item,
      map.length,map[0]===a,map[1]===b,map.getNamedItemNS('urn:b','item')===b,
      [...map].map(a=>a.value).join(),Object.keys(map).join(),map.removeNamedItemNS('urn:a','item')===a,
      map[0]===b,a.ownerElement===null];
  })()`)).toEqual([true,true,true,2,true,true,true,'a,b','0,1',true,true,true]);
});

test('attributes adopt their new document and namespace metadata survives cloning', async () => {
  expect(await evaluate(`(() => {
    const other=document.implementation.createDocument(null,null),e=other.createElement('test');
    const a=document.createAttributeNS('urn:a','p:Test');a.value='ok';e.setAttributeNode(a);
    const clone=a.cloneNode();
    return [a.ownerDocument===other,a.ownerElement===e,clone instanceof Attr,
      clone!==a,clone.ownerElement===null,clone.ownerDocument===other,clone.prefix,clone.localName,clone.value,
      other.createAttribute('UPPER').name,document.createAttribute('p:Name').localName];
  })()`)).toEqual([true,true,true,true,true,true,'p','Test','ok','UPPER','p:name']);
});

test('form proxies retain Attr owner identity and accept removal through their wrappers', async () => {
  expect(await evaluate(`(() => {
    const f=document.createElement('form');f.id='form';const a=f.getAttributeNode('id');
    return [a.ownerElement===f,f.removeAttributeNode(a)===a,a.ownerElement===null];
  })()`)).toEqual([true,true,true]);
});

test('namespaced attributes do not replace inline style or filtered mutation records', async () => {
  expect(await evaluate(`(() => {
    const e=document.createElement('div');document.body.append(e);
    e.setAttributeNS('urn:test','style','color:red');e.style.cssText='color:green';
    const first=getComputedStyle(e).color;
    const o=new MutationObserver(()=>{});o.observe(e,{attributes:true,attributeFilter:['style'],attributeOldValue:true});
    e.setAttributeNS('urn:test','style','color:blue');e.style.backgroundColor='yellow';
    const r=o.takeRecords();o.disconnect();
    const answer=[first,getComputedStyle(e).color,e.getAttributeNS('urn:test','style'),
      r.length,r[0].attributeNamespace,r[0].oldValue,e.getAttributeNS(null,'style')];e.remove();return answer;
  })()`)).toEqual(['rgb(0, 128, 0)','rgb(0, 128, 0)','color:blue',1,null,'color: green;','color: green; background-color: yellow;']);
});

test('Attr DOMString conversion uses the string hint and adoption invalidates old owner styles', async () => {
  expect(await evaluate(`(() => {
    const hints=[],name={ [Symbol.toPrimitive](hint){hints.push(hint);return hint==='string'?'data-test':'bad name'} };
    const a=document.createAttribute(name);a.value={toString(){return 'ok'},valueOf(){throw 1}};
    const e=document.createElement('div');e.setAttributeNode(a);
    const result=[e.getAttributeNode(name)===a,e.attributes.getNamedItem(name)===a,a.value,hints.join()];
    e.style.color='red';document.body.append(e);getComputedStyle(e);
    const other=document.implementation.createDocument(null,null);
    other.adoptNode(e.getAttributeNode('style'));
    result.push(e.style.color,e.hasAttribute('style'));e.remove();return result;
  })()`)).toEqual([true,true,'ok','string,string,string','',false]);
});

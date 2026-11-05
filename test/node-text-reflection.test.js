import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {BindingRealm, installNodeTextAccessors} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture() {
  const page = parseHTMLDocument('<!doctype html><div></div><textarea>abcdef</textarea>');
  const xml = createDetachedDocument(page.window, {contentType:'application/xml'});
  return {...page, xml};
}
const characterNodes = f => [f.document.createTextNode('old'), f.document.createComment('old'),
  f.document.createProcessingInstruction('target', 'old'), f.xml.createCDATASection('old')];

test('CharacterData and nullable Node text properties keep distinct conversions and UTF-16 data', () => {
  const f = fixture();
  try {
    for (const node of characterNodes(f)) {
      for (const property of ['data', 'nodeValue', 'textContent']) {
        for (const [value, expected] of [[null, ''], [undefined, property === 'data' ? 'undefined' : ''],
          [0, '0'], [123n, '123'], ['A\r\n\uD800😀', 'A\r\n\uD800😀'],
          [{toString(){return null}}, 'null']]) {
          node[property] = value;
          expect([node.data, node.nodeValue, node.textContent, node.length]).toEqual([expected, expected, expected, expected.length]);
        }
        let calls = 0;
        node[property] = {[Symbol.toPrimitive](hint){expect(hint).toBe('string');calls++;return 'once'}};
        expect(calls).toBe(1);expect(node.data).toBe('once');
        expect(()=>{node[property]=Symbol()}).toThrow(TypeError);expect(node.data).toBe('once');
      }
    }
    const attr=f.document.createAttribute('data-test'), element=f.document.querySelector('div'), fragment=f.document.createDocumentFragment();
    for(const node of [attr,element,fragment]) {
      node.textContent='old';node.textContent=undefined;expect(node.textContent).toBe('');
      node.textContent=0;expect(node.textContent).toBe('0');
    }
    for(const node of [f.document,f.xml,f.document.doctype]) {
      const children=[...node.childNodes];let hint;
      node.textContent={[Symbol.toPrimitive](h){hint=h;return 'no-op'}};
      expect(hint).toBe('string');expect(node.textContent).toBeNull();expect([...node.childNodes]).toEqual(children);
      expect(()=>{node.nodeValue=Symbol()}).toThrow(TypeError);expect(node.nodeValue).toBeNull();
    }
    const descriptor=Object.getOwnPropertyDescriptor(f.window.Node.prototype,'textContent');
    const text=f.document.createTextNode('before');descriptor.set.call(text,'after');expect(descriptor.get.call(text)).toBe('after');
  } finally {f.window.happyDOM.close();}
});

test('text reflection retains mutation records, attribute identity, subtree replacement and textarea hooks', () => {
  const f=fixture();
  try {
    const observer=new f.window.MutationObserver(()=>{});
    for(const node of characterNodes(f)) {
      observer.observe(node,{characterData:true,characterDataOldValue:true});
      node.nodeValue='first';node.textContent=undefined;node.data=undefined;
      const records=observer.takeRecords();
      expect(records.map(r=>r.oldValue)).toEqual(['old','first','']);
      expect(records.every(r=>r.target===node&&r.type==='characterData')).toBeTrue();observer.disconnect();
    }
    const element=f.document.querySelector('div');element.setAttribute('data-test','old');const attr=element.getAttributeNode('data-test');
    observer.observe(element,{attributes:true,attributeOldValue:true});attr.nodeValue=undefined;
    expect(element.getAttributeNode('data-test')).toBe(attr);expect(attr.value).toBe('');
    expect(observer.takeRecords().map(r=>r.oldValue)).toEqual(['old']);observer.disconnect();
    element.textContent='same';const previous=element.firstChild;element.textContent='same';
    expect(element.firstChild).not.toBe(previous);expect(previous.parentNode).toBeNull();
    element.textContent=undefined;expect(element.childNodes.length).toBe(0);
    const area=f.document.querySelector('textarea');area.setSelectionRange(2,5);area.firstChild.textContent='x\r\ny';
    expect(area.value).toBe('x\ny');expect(area.selectionEnd).toBeLessThanOrEqual(3);
    area.value='dirty';area.firstChild.nodeValue='new default';expect(area.value).toBe('dirty');expect(area.defaultValue).toBe('new default');
  } finally {f.window.happyDOM.close();}
});

test('text accessors use their defining realm for brands and conversion, but preserve author errors and receiver mutations', () => {
  const a=fixture(),b=fixture();
  class AError extends TypeError {}
  let touches=0;
  const ar=new BindingRealm(a.window,{touch(){throw Error('wrong realm')}}),br=new BindingRealm(b.window,{touch(){touches++}});
  ar.inputValueIntrinsics={TypeError:AError};const np={},cp={};installNodeTextAccessors(np,cp,ar);
  // The new operations capture intrinsics at installation, not mutable globals.
  ar.inputValueIntrinsics.TypeError=class IncorrectError extends Error {};
  try {
    for(const [proto,properties] of [[np,['nodeValue','textContent']],[cp,['data']]]) for(const property of properties) {
      const d=Object.getOwnPropertyDescriptor(proto,property),native=b.document.createTextNode('old'),node=br.wrap(native);
      for(const invalid of [null,undefined,{},proto,new Proxy(node,{})]) {
        expect(()=>d.get.call(invalid)).toThrow(AError);
        expect(()=>d.set.call(invalid,{toString(){throw 'brand checked too late'}})).toThrow(AError);
      }
      if(property==='data')expect(()=>d.set.call(br.wrap(b.document.createElement('div')),'x')).toThrow(AError);
      expect(()=>d.set.call(node,Symbol())).toThrow(AError);
      const sentinel=new TypeError('author error');let caught;
      try{d.set.call(node,{toString(){throw sentinel}})}catch(error){caught=error}expect(caught).toBe(sentinel);
      d.set.call(node,{[Symbol.toPrimitive](hint){expect(hint).toBe('string');native.data='reentered';return 'final'}});
      expect(d.get.call(node)).toBe('final');expect(native.data).toBe('final');
      const doc=br.wrap(b.document);
      if(property!=='data')expect(()=>d.set.call(doc,Symbol())).toThrow(AError);
    }
    expect(touches).toBe(3);
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('page text reflection updates actual pixels and styles, and preserves nullable and realm semantics', async()=>{
  const host=new RendererHost({timeout:20000});const run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try {
    await host.start();await host.call('loadDocument',{url:'https://node-text.test/',contentType:'text/html',source:'<!doctype html><style id=s>body{margin:0;background:white}#box{width:100px;height:50px;background:red;font:20px monospace}</style><div id=box>old</div>'});await host.call('whenLoaded');
    await run(`window.box=document.getElementById('box');window.styleText=document.getElementById('s').firstChild`);
    const original=await shot();await run(`box.firstChild.data=undefined`);expect(await shot()).not.toBe(original);
    expect(await run('box.textContent')).toBe('undefined');await run(`box.textContent=undefined`);const empty=await shot();
    expect(await run('box.childNodes.length')).toBe(0);await run(`box.textContent=null`);expect(await shot()).toBe(empty);
    await run(`styleText.nodeValue='body{margin:0;background:white}#box{width:100px;height:50px;background:blue;font:20px monospace}'`);
    expect(await run('getComputedStyle(box).backgroundColor')).toBe('rgb(0, 0, 255)');expect(await shot()).not.toBe(empty);
    expect(await run(`(()=>{
      const nodes=[document.createTextNode('old'),document.createComment('old'),document.createProcessingInstruction('p','old'),document.implementation.createDocument(null,null).createCDATASection('old')];
      const out=[];for(const node of nodes){node.nodeValue='next';out.push(node.data==='next');node.textContent=undefined;out.push(node.data==='');node.data=undefined;out.push(node.data==='undefined')}
      const setter=Object.getOwnPropertyDescriptor(Node.prototype,'textContent').set, OriginalError=TypeError;
      const sentinel=new OriginalError('author');let caught;try{setter.call(nodes[0],{toString(){throw sentinel}})}catch(e){caught=e}out.push(caught===sentinel);
      globalThis.TypeError=function(){throw 'wrong intrinsic'};
      for(const node of [nodes[0],document,document.doctype]){try{setter.call(node,Symbol());out.push(false)}catch(e){out.push(e instanceof OriginalError)}}
      globalThis.TypeError=OriginalError;out.push(document.textContent===null,document.doctype.textContent===null);
      return out;
    })()`)).toEqual(Array(18).fill(true));
  } finally {await host.close();}
},30000);

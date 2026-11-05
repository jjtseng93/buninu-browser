import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {parseXHTMLDocument} from '../lib/renderer/xhtml-document.js';
import {BindingRealm, installOuterHTMLAccessor} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';

const HTML='http://www.w3.org/1999/xhtml', SVG='http://www.w3.org/2000/svg';

test('outerHTML conversion and replacement preserve the old subtree and update live IDs and mutations',()=>{
  const f=parseHTMLDocument('<div id=parent><p id=old>original<b>child</b></p><span>last</span></div>');
  try {
    const {document:d,window:w}=f,parent=d.getElementById('parent'),old=d.getElementById('old');
    const observer=new w.MutationObserver(()=>{});observer.observe(parent,{childList:true});
    old.outerHTML='<i id=new>first</i>middle<em>second</em>';
    expect(old.outerHTML).toBe('<p id="old">original<b>child</b></p>');expect(old.parentNode).toBeNull();
    expect(d.getElementById('old')).toBeNull();expect(d.getElementById('new')).toBe(parent.firstChild);
    expect([...parent.childNodes].map(n=>n.nodeName)).toEqual(['I','#text','EM','SPAN']);
    const records=observer.takeRecords();expect(records.flatMap(r=>[...r.removedNodes])).toContain(old);
    expect(records.flatMap(r=>[...r.addedNodes])).toContain(d.getElementById('new'));observer.disconnect();
    for(const [value,text]of [[null,''],[undefined,'undefined'],[42,'42'],[{toString(){return 'string'},valueOf(){throw 'wrong hint'}},'string'],[{toString:undefined,valueOf(){return 'value'}},'value']]) {
      const node=d.createElement('div');parent.replaceChildren(node);node.outerHTML=value;expect(parent.textContent).toBe(text);
    }
    const node=d.createElement('div');node.textContent='detached';node.outerHTML='<p>ignored</p>';expect(node.textContent).toBe('detached');
    expect(()=>{node.outerHTML=Symbol()}).toThrow(TypeError);
    expect(()=>{d.documentElement.outerHTML='<html/>'}).toThrow(expect.objectContaining({name:'NoModificationAllowedError'}));
    const other=d.createElement('section');parent.append(other,node);let calls=0;
    node.outerHTML={[Symbol.toPrimitive](hint){expect(hint).toBe('string');calls++;other.append(node);return '<strong>moved</strong>'}};
    expect(calls).toBe(1);expect(other.firstChild.localName).toBe('strong');expect(node.parentNode).toBeNull();
  }finally{f.window.happyDOM.close()}
});

test('HTML outerHTML uses table, select, SVG, raw text and fragment context without evaluating scripts',()=>{
  const f=parseHTMLDocument('');
  try{
    const d=f.document;
    for(const [tag,markup,expected]of [
      ['table','<tr><td>cell</td></tr>','<tbody><tr><td>cell</td></tr></tbody>'],
      ['tbody','<tr><td>cell</td></tr>','<tr><td>cell</td></tr>'],
      ['tr','<td>cell</td>','<td>cell</td>'],['select','<option>choice</option>','<option>choice</option>'],
      ['svg','<circle r="2"/>','<circle r="2"></circle>'],
    ]){
      const parent=tag==='svg'?d.createElementNS(SVG,tag):d.createElement(tag),old=d.createElement('old');parent.append(old);old.outerHTML=markup;
      expect(parent.innerHTML).toBe(expected);expect(parent.firstChild.ownerDocument).toBe(d);
      expect(parent.firstChild.namespaceURI).toBe(tag==='svg'?SVG:HTML);
    }
    for(const [tag,text]of [['textarea','<b>&</b>'],['style','<b>&amp;</b>'],['script','<b>&amp;</b>']]){
      const parent=d.createElement(tag),old=d.createElement('old');parent.append(old);old.outerHTML='<b>&amp;</b>';
      expect(parent.childNodes.length).toBe(1);expect(parent.firstChild.nodeType).toBe(3);expect(parent.textContent).toBe(text);
    }
    const fragment=d.createDocumentFragment(),old=d.createElement('div');fragment.append(old);old.outerHTML='<body><b>fragment</b></body>';
    expect(fragment.firstChild.outerHTML).toBe('<b>fragment</b>');
    const template=d.createElement('template');template.innerHTML='<div>old</div>';template.content.firstChild.outerHTML='<span>new</span>';
    expect(template.innerHTML).toBe('<span>new</span>');
  }finally{f.window.happyDOM.close()}
});

test('XML fragments inherit namespaces, preserve case and CDATA, adopt nodes, and reject malformed input atomically',()=>{
  const f=parseXHTMLDocument(`<html xmlns="${HTML}" xmlns:p="urn:p"><head/><body><div id="old"/></body></html>`,'https://xml.test/');
  try {
    const d=f.document,old=d.getElementById('old');old.outerHTML='<p:item p:a="A"/><DIV id="new"/>text<![CDATA[<raw>]]><?pi data?>';
    const nodes=[...d.body.childNodes];expect(nodes.map(n=>n.nodeType)).toEqual([1,1,3,4,7]);
    expect(nodes.map(n=>n.ownerDocument===d)).toEqual([true,true,true,true,true]);
    expect(nodes[0].namespaceURI).toBe('urn:p');expect(nodes[0].prefix).toBe('p');
    expect(nodes[0].getAttributeNodeNS('urn:p','a').ownerDocument).toBe(d);
    expect(nodes[1].localName).toBe('DIV');expect(nodes[1].namespaceURI).toBe(HTML);expect(nodes[3].data).toBe('<raw>');
    for(const markup of ['<unclosed>','<no:prefix/>','<a a="1" a="2"/>','<p:x xmlns:p=""/>','</body><body/>','<?xml version="1.0"?>','<!DOCTYPE x><x/>']){
      const before=[...d.body.childNodes];expect(()=>{nodes[1].outerHTML=markup}).toThrow(expect.objectContaining({name:'SyntaxError'}));expect([...d.body.childNodes]).toEqual(before);
    }
    const implicit=d.createElementNS('urn:implicit','q:parent'),child=d.createElement('child');implicit.append(child);
    child.outerHTML='<q:child/>';expect(implicit.firstChild.namespaceURI).toBe('urn:implicit');
    const fragment=d.createDocumentFragment(),leaf=d.createElement('leaf');fragment.append(leaf);leaf.outerHTML='<b/>';
    expect(fragment.firstChild.namespaceURI).toBe(HTML);
  }finally{f.window.happyDOM.close()}
});

test('outerHTML accessor captures defining realm errors and preserves author exceptions and actual receiver realm',()=>{
  const a=parseHTMLDocument(''),b=parseHTMLDocument('<main><div>old</div></main>');class AError extends TypeError{}
  let touched;const ar=new BindingRealm(a.window,{touch(){throw 'wrong realm'}}),br=new BindingRealm(b.window,{touch(node){touched=node}});
  ar.inputValueIntrinsics={TypeError:AError};const prototype={};installOuterHTMLAccessor(prototype,ar);
  const descriptor=Object.getOwnPropertyDescriptor(prototype,'outerHTML'),native=b.document.querySelector('div'),wrapped=br.wrap(native);
  try{
    for(const receiver of [null,{},prototype,br.wrap(b.document),new Proxy(wrapped,{})]){
      expect(()=>descriptor.get.call(receiver)).toThrow(AError);
      expect(()=>descriptor.set.call(receiver,{toString(){throw 'late brand'}})).toThrow(AError);
    }
    ar.inputValueIntrinsics.TypeError=Error;expect(()=>descriptor.set.call(wrapped,Symbol())).toThrow(AError);
    const sentinel=new TypeError('author');let caught;try{descriptor.set.call(wrapped,{toString(){throw sentinel}})}catch(error){caught=error}expect(caught).toBe(sentinel);
    descriptor.set.call(wrapped,'<p>new</p>');expect(touched).toBe(b.document.querySelector('main'));expect(native.textContent).toBe('old');
  }finally{a.window.happyDOM.close();b.window.happyDOM.close()}
});

test('page outerHTML paints replacement HTML/XML, updates IDs, and keeps fragment scripts inert',async()=>{
  const host=new RendererHost({timeout:20000});const run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try{
    await host.start();
    for(const xml of [false,true]){
      const source=`<html xmlns="${HTML}"><head><style>body{margin:0;background:white}div{display:block;width:40px;height:40px;background:red}</style></head><body><div id="old">old</div></body></html>`;
      await host.call('loadDocument',{url:'https://outer.test/',contentType:xml?'application/xhtml+xml':'text/html',source});await host.call('whenLoaded');
      const before=await shot();expect(await run(`(()=>{const old=document.getElementById('old');old.outerHTML='<div id="new" style="background:blue">new</div><script>globalThis.shouldNotRun=1</script>';return [old.isConnected,old.textContent,document.getElementById('old')===null,document.getElementById('new').namespaceURI,globalThis.shouldNotRun===undefined]})()`)).toEqual([false,'old',true,HTML,true]);
      expect(await shot()).not.toBe(before);
      expect(await run(`(()=>{const set=Object.getOwnPropertyDescriptor(Element.prototype,'outerHTML').set;try{set.call(document.documentElement,'<html/>')}catch(e){return [e instanceof DOMException,e.name]}})()`)).toEqual([true,'NoModificationAllowedError']);
      expect(await run(`(()=>{const value=trustedTypes.createPolicy('outer', {createHTML:s=>s}).createHTML('<b id="trusted">ok</b>');document.getElementById('new').outerHTML=value;return document.getElementById('trusted').textContent})()`)).toBe('ok');
    }
  }finally{await host.close()}
},30000);

import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {BindingRealm,installCDATAFactory,nodeOf} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture() {
  const page=parseHTMLDocument('');
  return {...page,xml:createDetachedDocument(page.window,{contentType:'application/xml'})};
}

test('CDATA is a real Text subtype with clone, split, normalization and mutation semantics',()=>{
  const {window,document,xml}=fixture();
  try {
    const root=xml.createElementNS(null,'root');xml.appendChild(root);
    const a=xml.createTextNode('A'),c=xml.createCDATASection('BC'),empty=xml.createCDATASection(''),d=xml.createTextNode('D');root.append(a,c,empty,d);
    expect([c.nodeType,c.nodeName,c.data,c.length,c.ownerDocument===xml]).toEqual([4,'#cdata-section','BC',2,true]);
    for(const n of [a,c,empty,d])expect(n.wholeText).toBe('ABCD');
    expect(root.textContent).toBe('ABCD');root.normalize();expect([...root.childNodes]).toEqual([a,c,empty,d]);
    const clone=c.cloneNode(true);expect([clone.nodeType,clone.data,clone.ownerDocument===xml,clone.isEqualNode(c)]).toEqual([4,'BC',true,true]);
    clone.data='other';expect(clone.isEqualNode(c)).toBeFalse();expect(c.isEqualNode(xml.createTextNode('BC'))).toBeFalse();
    const rest=c.splitText(1);expect([c.data,rest.data,rest.nodeType,rest.ownerDocument===xml,c.nextSibling===rest]).toEqual(['B','C',3,true,true]);
    const observer=new window.MutationObserver(()=>{});observer.observe(c,{characterData:true,characterDataOldValue:true});
    c.data=']]>';c.appendData('x');expect(observer.takeRecords().map(r=>r.oldValue)).toEqual(['B',']]>']);observer.disconnect();
    const fragment=xml.createDocumentFragment();fragment.append(clone);expect(fragment.textContent).toBe('other');
    const imported=document.importNode(clone,true);expect([imported.nodeType,imported.data,imported.ownerDocument===document]).toEqual([4,'other',true]);
    expect(document.adoptNode(clone)).toBe(clone);expect(clone.ownerDocument).toBe(document);expect(clone.cloneNode().ownerDocument===document).toBeTrue();
    expect(()=>xml.appendChild(c)).toThrow(DOMException);expect(()=>c.appendChild(a)).toThrow(DOMException);
    expect(c.parentNode).toBe(root);expect(a.parentNode).toBe(root);
    const ranged=document.importNode(c);document.body.append(ranged);const range=document.createRange();range.setStart(ranged,1);range.setEnd(ranged,3);expect([range.startOffset,range.endOffset]).toEqual([1,3]);
    const subtree=xml.createElementNS(null,'subtree'),nested=xml.createCDATASection('XYZ');subtree.setAttribute('a','b');subtree.append(nested);
    document.adoptNode(subtree);expect(nested.ownerDocument===document).toBeTrue();expect(subtree.attributes[0].ownerDocument===document).toBeTrue();
    const split=nested.splitText(1);expect([split.nodeType,split.ownerDocument===document,nested.cloneNode().ownerDocument===document]).toEqual([3,true,true]);
  } finally {window.happyDOM.close();}
});

test('CDATA factory enforces document mode, IDL order and defining-realm errors',()=>{
  class ATypeError extends TypeError{} class AException extends DOMException{}
  const a=fixture(),b=fixture();
  try {
    const realmA=new BindingRealm(a.window,{touch(){}}),realmB=new BindingRealm(b.window,{touch(){}});
    realmA.inputValueIntrinsics={TypeError:ATypeError,DOMException:AException};
    const proto={};installCDATAFactory(proto,realmA);const create=proto.createCDATASection,doc=realmB.wrap(b.xml);
    for(const invalid of [undefined,null,{},proto,new Proxy(doc,{}),realmB.wrap(b.document.createElement('div'))]) {
      expect(()=>create.call(invalid,{toString(){throw 'converted too early'}})).toThrow(ATypeError);
    }
    expect(()=>create.call(doc)).toThrow(ATypeError);expect(()=>create.call(doc,Symbol())).toThrow(ATypeError);
    const values=[null,undefined,123n,'\0\v\uD800',''];
    for(const value of values){const node=create.call(doc,value);expect(nodeOf(node).ownerDocument).toBe(b.xml);expect(node.data).toBe(String(value));}
    expect(()=>create.call(doc,'bad]]>')).toThrow(AException);
    const html=realmB.wrap(b.document);let order=[];expect(()=>create.call(html,{toString(){order.push('convert');return ']]>'}})).toThrow(AException);expect(order).toEqual(['convert']);
    let error;try{create.call(html,'bad]]>')}catch(e){error=e}expect(error.name).toBe('NotSupportedError');
    const sentinel={};try{create.call(html,{toString(){throw sentinel}})}catch(e){error=e}expect(error).toBe(sentinel);
    for(const type of ['text/xml','application/xml','application/xhtml+xml','image/svg+xml'])expect(createDetachedDocument(a.window,{contentType:type}).createCDATASection('ok').data).toBe('ok');
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('XML parsing preserves CDATA boundaries while HTML and XML serialize differently',()=>{
  const {window,document,xml}=fixture();
  try {
    const parser=new window.DOMParser();
    const parsed=parser.parseFromString('<root>A<![CDATA[<tag>&amp;\r\n\r]]><![CDATA[]]>Z</root>','application/xml');
    expect([...parsed.documentElement.childNodes].map(n=>[n.nodeType,n.data])).toEqual([[3,'A'],[4,'<tag>&amp;\n\n'],[4,''],[3,'Z']]);
    expect(parsed.documentElement.textContent).toBe('A<tag>&amp;\n\nZ');
    expect(new window.XMLSerializer().serializeToString(parsed)).toBe('<root>A<![CDATA[<tag>&amp;\n\n]]><![CDATA[]]>Z</root>');
    const adopted=document.adoptNode(parsed.documentElement);expect(adopted.outerHTML).toBe('<root>A&lt;tag&gt;&amp;amp;\n\nZ</root>');
    for(const source of ['<x><![CDATA[unterminated</x>','<![CDATA[x]]><x/>','<x/><![CDATA[x]]>']) {
      expect(parser.parseFromString(source,'application/xml').querySelector('parsererror')).not.toBeNull();
    }
    const html=parser.parseFromString('<div><![CDATA[html]]></div>','text/html');expect(html.querySelector('div').firstChild.nodeType).toBe(8);
    const svg=xml.createElementNS('http://www.w3.org/2000/svg','script');svg.append(xml.createCDATASection('<&>'));
    expect(svg.outerHTML).toBe('<script>&lt;&amp;&gt;</script>');
    expect(new window.XMLSerializer().serializeToString(svg)).toBe('<script xmlns="http://www.w3.org/2000/svg"><![CDATA[<&>]]></script>');
  } finally {window.happyDOM.close();}
});

test('CDATA page interfaces, textarea defaults, mutation painting and serialization share real nodes',async()=>{
  const host=new RendererHost();const run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try {
    await host.start();await host.call('loadDocument',{url:'https://cdata.test/',contentType:'text/html',source:'<style>body{font:20px monospace}textarea{display:block}</style><div id=output></div><textarea id=t></textarea>'});await host.call('whenLoaded');
    expect(await run(`(()=>{window.xml=new Document();window.c=xml.createCDATASection('hello');output.append(c);return [c instanceof CDATASection,c instanceof Text,c instanceof CharacterData,c instanceof Node,Object.getPrototypeOf(CDATASection.prototype)===Text.prototype,Object.getPrototypeOf(CDATASection)===Text,c.constructor===CDATASection,Object.prototype.toString.call(c),c.ownerDocument===document,Object.getOwnPropertySymbols(c).length]})()`)).toEqual([true,true,true,true,true,true,true,'[object CDATASection]',true,0]);
    const hello=await shot();await run(`c.data='changed'`);expect(await shot()).not.toBe(hello);
    await run(`c.nodeValue='hello'`);expect(await shot()).toBe(hello);
    expect(await run(`(()=>{t.append(xml.createCDATASection('A\\r\\nB'));const clone=c.cloneNode();const rest=c.splitText(2);return [t.defaultValue,t.value,clone instanceof CDATASection,rest instanceof Text,rest instanceof CDATASection,rest.nodeType,c.wholeText,output.textContent,output.innerText]})()`)).toEqual(['A\r\nB','A\nB',true,true,false,3,'hello','hello','hello']);
    expect(await run(`(()=>{const results=[];for(const n of [document.createTextNode('x'),document.createComment('x'),xml.createCDATASection('x')]){n.nodeValue=null;results.push(n.nodeValue);n.nodeValue=undefined;results.push(n.nodeValue);try{n.nodeValue=Symbol();results.push(false)}catch(e){results.push(e.name==='TypeError')}}return results})()`)).toEqual(['','',true,'','',true,'','',true]);
    expect(await run(`(()=>{const checks=[];for(const f of [()=>new CDATASection(),()=>CDATASection(),()=>Document.prototype.createCDATASection.call({},'x'),()=>xml.createCDATASection(Symbol())]){try{f();checks.push(false)}catch(e){checks.push(e instanceof TypeError)}}try{document.createCDATASection('x')}catch(e){checks.push(e instanceof DOMException&&e.name==='NotSupportedError')}const n=xml.createCDATASection('<x>');checks.push(new XMLSerializer().serializeToString(n)==='<![CDATA[<x>]]>');return checks})()`)).toEqual([true,true,true,true,true,true]);
  } finally {await host.close();}
},30000);

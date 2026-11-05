import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {BindingRealm, nodeOf, installDocumentTransferMethods} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

test('adoption keeps identities and internal owners through repeated subtree and Attr transfers', () => {
  const {window, document:a} = parseHTMLDocument('<div id=holder><section id=item data-x=one><input value=default><b title=child>text</b></section></div>');
  try {
    const b=createDetachedDocument(window), c=createDetachedDocument(window), root=a.getElementById('item');
    const input=root.firstChild, child=root.lastChild, text=child.firstChild, attr=root.getAttributeNode('data-x');
    input.value='edited';
    const observer=new window.MutationObserver(()=>{});observer.observe(a.getElementById('holder'),{childList:true});
    for (const target of [a,b,c,a,b]) {
      expect(target.adoptNode(root)===root).toBe(true);
      for (const node of [root,input,child,text,attr,child.attributes[0]]) {
        expect(node.ownerDocument===target && node[S.ownerDocument]===target).toBe(true);
        expect(Object.hasOwn(node,'ownerDocument')).toBe(false);
      }
      expect(root.parentNode===null).toBe(true);expect(input.value).toBe('edited');
    }
    const records=observer.takeRecords();expect(records.length).toBe(1);expect(records[0].removedNodes[0]===root).toBe(true);
    observer.disconnect();observer.observe(root,{attributes:true,attributeOldValue:true});
    expect(c.adoptNode(attr)===attr).toBe(true);expect(attr.ownerElement===null).toBe(true);
    expect(root.hasAttribute('data-x')).toBe(false);expect(attr.ownerDocument===c).toBe(true);
    expect(observer.takeRecords().map(r=>[r.type,r.attributeName,r.oldValue])).toEqual([['attributes','data-x','one']]);
    expect(a.adoptNode(attr)===attr && attr.ownerDocument===a).toBe(true);
    observer.disconnect();
  } finally {window.happyDOM.close();}
});

test('adopt/import reject document and shadow roots before mutation, while real fragments remain transferable', () => {
  const {window, document:a}=parseHTMLDocument('<div></div>');
  try {
    const b=createDetachedDocument(window), host=a.querySelector('div'), root=host.attachShadow({mode:'closed'});
    root.append(a.createElement('span'));const child=root.firstChild;
    for (const [method,node,name] of [['adoptNode',a,'NotSupportedError'],['importNode',a,'NotSupportedError'],
      ['adoptNode',root,'HierarchyRequestError'],['importNode',root,'NotSupportedError']]) {
      let thrown;try{b[method](node,true)}catch(e){thrown=e}
      expect(thrown?.name).toBe(name);expect(root.firstChild===child && child.ownerDocument===a).toBe(true);
      expect(host.isConnected).toBe(true);
    }
    const fragment=a.createDocumentFragment();fragment.append(a.createTextNode('fragment'));
    expect(b.adoptNode(fragment)===fragment).toBe(true);expect(fragment.firstChild.ownerDocument===b).toBe(true);
    const template=a.createElement('template');template.innerHTML='<b>x</b>';
    const content=template.content;expect(b.adoptNode(content)===content).toBe(true);
    expect(content.firstChild.ownerDocument===b).toBe(true);
    expect(()=>b.adoptNode(null)).toThrow(TypeError);expect(()=>b.importNode({})).toThrow(TypeError);
  } finally {window.happyDOM.close();}
});

test('shadow-inclusive descendants and imported subtree attributes share the destination document', () => {
  const {window,document:a}=parseHTMLDocument('<div id=host data-source=original><input value=default><b title=light>text</b></div>');
  try {
    const b=createDetachedDocument(window), host=a.getElementById('host'), input=host.firstChild;
    input.value='edited';
    const shadow=host.attachShadow({mode:'open',clonable:true});
    const child=a.createElementNS('urn:test','p:item');child.setAttributeNS('urn:attr','a:label','shadow');
    shadow.append(child);child.append(a.createTextNode('inside'));
    const imported=b.importNode(host,true);
    expect(imported!==host && imported.ownerDocument===b).toBe(true);
    expect(imported.firstChild.value).toBe('edited');
    for(const node of [imported, ...imported.children, imported.attributes[0], imported.lastChild.attributes[0],
      imported.shadowRoot, imported.shadowRoot.firstChild, imported.shadowRoot.firstChild.attributes[0], imported.shadowRoot.firstChild.firstChild])
      expect(node.ownerDocument===b && node[S.ownerDocument]===b).toBe(true);
    expect(imported.shadowRoot.firstChild.prefix).toBe('p');expect(child.ownerDocument===a).toBe(true);
    expect(host.attributes[0].ownerDocument===a).toBe(true);
    b.adoptNode(host);
    for(const node of [host,host.attributes[0],input,shadow,child,child.attributes[0],child.firstChild])expect(node.ownerDocument===b).toBe(true);
    a.adoptNode(host);expect(child.ownerDocument===a && child.attributes[0].ownerDocument===a).toBe(true);
    expect(host.shadowRoot===shadow).toBe(true);
  } finally {window.happyDOM.close();}
});

test('implicit insertion updates attributes before connection callbacks and preserves form ownership', () => {
  const first=parseHTMLDocument('<form id=source><input id=field name=x value=default></form>');
  const second=parseHTMLDocument('<form id=destination></form>');
  try {
    const a=first.document,b=second.document,input=a.getElementById('field'),target=b.getElementById('destination');
    const attribute=input.getAttributeNode('name'), seen=[];
    const connected=input[S.connectedToDocument];
    input[S.connectedToDocument]=function(){seen.push([this.ownerDocument===b,attribute.ownerDocument===b]);return connected.call(this)};
    target.append(input);expect(seen).toEqual([[true,true]]);expect(input.form===target).toBe(true);
    expect(a.getElementById('source').elements.length).toBe(0);expect(target.elements[0]===input).toBe(true);
    input.value='edited';target.reset();expect(input.value).toBe('default');
    const clone=a.importNode(input,true);expect(clone.attributes[0].ownerDocument===a).toBe(true);
    expect(input.ownerDocument===b).toBe(true);
  } finally {first.window.happyDOM.close();second.window.happyDOM.close();}
});

test('document transfer borrowed methods use defining-realm errors and receiver services', () => {
  const first=parseHTMLDocument('<div style="color:red"><span></span></div>'),second=parseHTMLDocument('');
  try {
    class ATypeError extends TypeError{} class AException extends DOMException{}
    const touched=[],a=new BindingRealm(first.window,{touch:n=>touched.push(n)}),b=new BindingRealm(second.window,{touch(){}});
    a.inputValueIntrinsics={TypeError:ATypeError,DOMException:AException};
    const prototype={};installDocumentTransferMethods(prototype,a);
    const target=b.wrap(second.document),element=a.wrap(first.document.querySelector('div'));
    for(const method of Object.values(prototype)) {
      for(const invalid of [undefined,null,{},prototype,element,new Proxy(target,{})])expect(()=>method.call(invalid,element)).toThrow(ATypeError);
      for(const invalid of [undefined,null,{},Symbol(),new Proxy(element,{})])expect(()=>method.call(target,invalid)).toThrow(ATypeError);
      expect(()=>method.call(target,a.wrap(first.document))).toThrow(AException);
    }
    const copy=prototype.importNode.call(target,element,true);
    expect(nodeOf(copy)!==nodeOf(element) && nodeOf(copy).ownerDocument===second.document).toBe(true);
    expect(nodeOf(copy).attributes[0].ownerDocument===second.document).toBe(true);
    expect(prototype.adoptNode.call(target,element)===b.wrap(nodeOf(element))).toBe(true);
    expect([touched.length,touched[0]===first.document.body]).toEqual([1,true]);
    expect(nodeOf(element).ownerDocument===second.document).toBe(true);
  } finally {first.window.happyDOM.close();second.window.happyDOM.close();}
});

test('page transfer repaints removed and imported nodes, preserves identities and exposes page errors',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://adopt.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0}#source{width:80px;height:60px;background:red}</style><div id=source data-color=red><span title=child>MOVE</span></div>'});
    await host.call('whenLoaded');
    const before=await host.call('screenshot',{format:'png'});
    expect(await host.call('evaluate',`(()=>{window.other=new Document();window.saved=document.getElementById('source');const same=other.adoptNode(saved);return [same===saved,saved.ownerDocument===other,saved.firstChild.ownerDocument===other,saved.attributes[0].ownerDocument===other,saved.parentNode===null,Object.hasOwn(saved,'ownerDocument')]})()`)).toEqual([true,true,true,true,true,false]);
    expect(await host.call('screenshot',{format:'png'})).not.toBe(before);
    expect(await host.call('evaluate',`(()=>{const copy=document.importNode(saved,true);document.body.append(copy);return [copy!==saved,copy.ownerDocument===document,copy.firstChild.ownerDocument===document,copy.firstChild.attributes[0].ownerDocument===document,saved.ownerDocument===other]})()`)).toEqual([true,true,true,true,true]);
    expect(await host.call('screenshot',{format:'png'})).toBe(before);
    expect(await host.call('evaluate',`(()=>{const result=[];for(const method of ['adoptNode','importNode']){for(const receiver of [{},Document.prototype,new Proxy(document,{})])try{Document.prototype[method].call(receiver,saved);result.push(false)}catch(e){result.push(e instanceof TypeError)}try{document[method]({});result.push(false)}catch(e){result.push(e instanceof TypeError)}try{document[method](other);result.push(false)}catch(e){result.push(e instanceof DOMException&&e.name==='NotSupportedError')}}document.adoptNode(saved);other.adoptNode(saved);result.push(saved.ownerDocument===other);return result})()`)).toEqual(Array(11).fill(true));
  } finally {await host.close();}
});

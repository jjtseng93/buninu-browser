import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {BindingRealm, installNodeQueryMethods} from '../lib/renderer/bindings.js';
import {locateNamespace, locateNamespacePrefix, elementById} from '../lib/happy-dom/node-queries.js';
import {RendererHost} from '../lib/renderer/host.js';

const XML = 'http://www.w3.org/XML/1998/namespace', XMLNS = 'http://www.w3.org/2000/xmlns/';
function fixture() {
  const page = parseHTMLDocument('<!doctype html><div></div>');
  return {...page, xml: createDetachedDocument(page.window, {contentType:'application/xml'})};
}

test('namespace lookup uses Element context and real XMLNS declarations only', () => {
  const f = fixture(), d = f.xml;
  try {
    const fragment=d.createDocumentFragment(), attr=d.createAttribute('unused');
    for(const node of [d,fragment,attr,f.document.doctype,d.createTextNode('x'),d.createComment('x')]) {
      for(const prefix of [null,'xml','xmlns','p'])expect(locateNamespace(node,prefix)).toBeNull();
      expect(locateNamespacePrefix(node,XML)).toBeNull();
    }
    const root=d.createElementNS(null,'root');d.append(root);
    root.setAttribute('xmlns','urn:fake');root.setAttribute('xmlns:p','urn:fake-p');
    expect(locateNamespace(root,null)).toBeNull();expect(locateNamespace(root,'p')).toBeNull();
    root.setAttributeNS(XMLNS,'xmlns','urn:default');root.setAttributeNS(XMLNS,'xmlns:p','urn:p');
    root.setAttributeNS(XMLNS,'xmlns:q','urn:q');root.setAttributeNS(XMLNS,'xmlns:null','null');
    const child=d.createElementNS(null,'child');root.append(child);child.append(d.createTextNode('x'),d.createComment('y'));
    child.setAttributeNode(attr);
    for(const node of [root,d,child,attr,child.firstChild,child.lastChild]) {
      expect(locateNamespace(node,null)).toBe('urn:default');expect(locateNamespace(node,'p')).toBe('urn:p');
      expect(locateNamespace(node,'xml')).toBe(XML);expect(locateNamespace(node,'xmlns')).toBe(XMLNS);
      expect(locateNamespacePrefix(node,'urn:p')).toBe('p');expect(locateNamespacePrefix(node,'urn:default')).toBeNull();
    }
    child.setAttributeNS(XMLNS,'xmlns','');child.setAttributeNS(XMLNS,'xmlns:p','');
    expect(locateNamespace(child,null)).toBeNull();expect(locateNamespace(child,'p')).toBeNull();
    const own=d.createElementNS('urn:own','p:item');child.append(own);
    own.setAttributeNS(XMLNS,'xmlns:p','urn:other');
    expect(locateNamespace(own,'p')).toBe('urn:own');expect(locateNamespacePrefix(own,'urn:own')).toBe('p');
    child.removeAttributeNode(attr);expect(locateNamespace(attr,'xml')).toBeNull();
    fragment.append(root);expect(locateNamespace(fragment,'xml')).toBeNull();expect(locateNamespace(d,'xml')).toBeNull();
    expect(locateNamespace(root,'p')).toBe('urn:p');
  } finally {f.window.happyDOM.close();}
});

test('fragment IDs are exact UTF-16 strings and stay within ordinary descendant tree order', () => {
  const f=fixture(),d=f.document,fragment=d.createDocumentFragment();
  try {
    const ids=['','\0','\uFFFD','\uD800','\uDC00','a:b','#x','a\\b','"[]','null','undefined'];
    for(const id of ids) {
      const element=d.createElement('div');element.id=id;fragment.append(element);
      expect(elementById(fragment,id)).toBe(id===''?null:element);
      expect(fragment.getElementById(id)).toBe(id===''?null:element);
    }
    const first=d.createElement('section'),second=d.createElement('p'),nested=d.createElement('b');
    first.id=second.id=nested.id='repeat';first.append(nested);fragment.prepend(first);fragment.append(second);
    expect(elementById(fragment,'repeat')).toBe(first);first.removeAttribute('id');expect(elementById(fragment,'repeat')).toBe(nested);
    fragment.prepend(second);expect(elementById(fragment,'repeat')).toBe(second);second.remove();expect(elementById(fragment,'repeat')).toBe(nested);
    const shadow=first.attachShadow({mode:'closed'}),shadowChild=d.createElement('i');shadowChild.id='shadow';shadow.append(shadowChild);
    expect(elementById(fragment,'shadow')).toBeNull();expect(elementById(shadow,'shadow')).toBe(shadowChild);
    const template=d.createElement('template');template.innerHTML='<b id=template></b>';fragment.append(template);
    expect(elementById(fragment,'template')).toBeNull();expect(elementById(template.content,'template')).toBe(template.content.firstChild);
    const namespaced=d.createElement('div');namespaced.setAttributeNS('urn:id','id','foreign');fragment.append(namespaced);
    expect(elementById(fragment,'foreign')).toBeNull();
  } finally {f.window.happyDOM.close();}
});

test('document ID index resolves duplicate tree order through moves, attributes and adoption', () => {
  const f=fixture(),d=f.document,other=createDetachedDocument(f.window);
  try {
    const a=d.createElement('div'),b=d.createElement('div'),c=d.createElement('div');a.id=b.id=c.id='same';
    d.body.append(a,b);d.body.insertBefore(c,a);expect(elementById(d,'same')).toBe(c);
    expect(d.getElementById('same')).toBe(c);
    a.prepend(b);expect(elementById(d,'same')).toBe(c);c.remove();expect(elementById(d,'same')).toBe(a);
    d.body.prepend(b);expect(elementById(d,'same')).toBe(b);
    b.getAttributeNode('id').value='different';expect(elementById(d,'same')).toBe(a);expect(elementById(d,'different')).toBe(b);
    b.setAttribute('id','same');expect(elementById(d,'same')).toBe(b);
    const html=other.createElement('html');other.append(html);html.append(other.adoptNode(b));
    expect(elementById(d,'same')).toBe(a);expect(elementById(other,'same')).toBe(b);
    expect(d.getElementById('same')).toBe(a);expect(other.getElementById('same')).toBe(b);
    a.removeAttribute('id');expect(elementById(d,'same')).toBeNull();
    const shadow=a.attachShadow({mode:'open'}),hidden=d.createElement('span');hidden.id='same';shadow.append(hidden);
    expect(elementById(d,'same')).toBeNull();expect(elementById(shadow,'same')).toBe(hidden);
    for(const id of ['\0','\uFFFD','\uD800','null','undefined']) {
      const e=d.createElement('b');e.id=id;d.body.append(e);expect(elementById(d,id)).toBe(e);
    }
    // A unique lookup must not enumerate document descendants or compare trees.
    a.id='unique';a.compareDocumentPosition=()=>{throw Error('unique ID should not compare trees')};
    Object.defineProperty(d,'firstElementChild',{get(){throw Error('must use ID index')}});
    expect(elementById(d,'unique')).toBe(a);expect(elementById(d,'missing')).toBeNull();
    expect(d.getElementById('unique')).toBe(a);expect(d.getElementById('missing')).toBeNull();
  } finally {f.window.happyDOM.close();}
});

test('query WebIDL methods capture defining-realm errors, convert once and wrap receiver-realm results', () => {
  const a=fixture(),b=fixture();class DefiningError extends TypeError{}
  const ar=new BindingRealm(a.window,{touch(){}}),br=new BindingRealm(b.window,{touch(){}});
  ar.inputValueIntrinsics={TypeError:DefiningError};const np={},dp={},fp={};installNodeQueryMethods(np,dp,fp,ar);
  ar.inputValueIntrinsics.TypeError=class IncorrectError extends Error{};
  try {
    const document=br.wrap(b.document),fragment=b.document.createDocumentFragment(),frag=br.wrap(fragment);
    const native=b.document.createElementNS(null,'item'),element=br.wrap(native);fragment.append(native);
    native.setAttributeNS(XMLNS,'xmlns','urn:default');native.setAttributeNS(XMLNS,'xmlns:p','urn:p');
    native.setAttributeNS(XMLNS,'xmlns:null','null');
    const methods=[...Object.values(np),dp.getElementById,fp.getElementById];
    for(const method of methods) {
      for(const invalid of [undefined,null,{},np,new Proxy(element,{})])
        expect(()=>method.call(invalid,{toString(){throw Error('must check brand first')}})).toThrow(DefiningError);
      const receiver=method===dp.getElementById?document:method===fp.getElementById?frag:element;
      expect(()=>method.call(receiver)).toThrow(DefiningError);expect(()=>method.call(receiver,Symbol())).toThrow(DefiningError);
      const sentinel=new TypeError('author error');let caught;
      try{method.call(receiver,{toString(){throw sentinel}})}catch(e){caught=e}expect(caught).toBe(sentinel);
      let calls=0;method.call(receiver,{[Symbol.toPrimitive](hint){expect(hint).toBe('string');calls++;return 'p'}});expect(calls).toBe(1);
    }
    expect(()=>dp.getElementById.call(frag,'x')).toThrow(DefiningError);
    expect(()=>fp.getElementById.call(document,'x')).toThrow(DefiningError);
    for(const value of [null,undefined,''])expect(np.lookupNamespaceURI.call(element,value)).toBe('urn:default');
    expect(np.lookupNamespaceURI.call(element,{toString(){return null}})).toBe('null');
    expect(np.isDefaultNamespace.call(element,{toString(){return 'urn:default'}})).toBeTrue();
    expect(np.lookupPrefix.call(element,{toString(){return 'urn:p'}})).toBe('p');
    native.id='null';expect(fp.getElementById.call(frag,null)).toBe(element);
    native.id='undefined';expect(fp.getElementById.call(frag,undefined)).toBe(element);
    expect(fp.getElementById.call(frag,{toString(){native.id='changed';return 'changed'}})).toBe(element);
    b.document.body.append(native);expect(dp.getElementById.call(document,'changed')).toBe(element);
    expect(np.lookupNamespaceURI.call(element,{toString(){native.setAttributeNS(XMLNS,'xmlns:p','urn:changed');return 'p'}})).toBe('urn:changed');
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('page query installers preserve exact IDs and namespace rules after globals are overwritten', async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://node-query.test/',contentType:'text/html',source:'<!doctype html><div id=same></div>'});await host.call('whenLoaded');
    expect(await host.call('evaluate',`(()=>{
      const out=[],frag=document.createDocumentFragment(),e=document.createElement('div');e.id='\\0';frag.append(e);
      out.push(frag.getElementById('\\0')===e,frag.getElementById('')===null,frag.lookupNamespaceURI('xml')===null,document.doctype.lookupNamespaceURI('xml')===null);
      const first=document.getElementById('same'),second=document.createElement('div');second.id='same';first.before(second);out.push(document.getElementById('same')===second);
      const xml=document.implementation.createDocument(null,null),root=xml.createElementNS(null,'root');xml.append(root);
      root.setAttributeNS('${XMLNS}','xmlns:p','urn:p');out.push(root.lookupNamespaceURI({toString(){return 'p'}})==='urn:p');
      const OriginalError=TypeError;globalThis.TypeError=function(){throw 'mutable global used'};
      for(const call of [()=>Node.prototype.lookupNamespaceURI.call({},{toString(){throw 'brand late'}}),()=>root.lookupNamespaceURI(Symbol()),()=>frag.getElementById(),()=>document.getElementById(Symbol())]){
        try{call();out.push(false)}catch(e){out.push(e instanceof OriginalError)}
      }
      globalThis.TypeError=OriginalError;return out;
    })()`)).toEqual(Array(10).fill(true));
    await host.call('evaluate',`document.body.innerHTML='<style>body{margin:0}</style><div style="height:100px"></div><div id="fragment" style="height:20px;background:red"></div><div style="height:1500px"></div>';
      window.later=document.getElementById('fragment');window.earlier=document.createElement('div');earlier.id='fragment';earlier.textContent='earlier';later.textContent='later';earlier.style.cssText='height:20px;background:blue';later.before(earlier);
      const spacer=document.createElement('div');spacer.style.height='300px';later.before(spacer);`);
    await host.call('screenshot',{format:'png'});
    expect(await host.call('evaluate','document.getElementById("fragment")===earlier')).toBeTrue();
    await host.call('showFragment','https://node-query.test/#fragment');
    expect(await host.call('evaluate','scrollY')).toBe(100);
    expect(await host.call('evaluate','earlier.getBoundingClientRect().top')).toBe(0);
  } finally {await host.close();}
},30000);

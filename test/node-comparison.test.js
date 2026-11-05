import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {containsNode, compareNodePosition} from '../lib/happy-dom/node-comparison.js';
import {BindingRealm, installNodeComparisonMethods} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';

const fixture = () => parseHTMLDocument('<!doctype html><body><main><a>text<!--comment--></a><b></b></main></body>');
const reverse = value => value === 0 ? 0 : (value & ~30) | (value & 2 ? 4 : 2) | (value & 8 ? 16 : value & 16 ? 8 : 0);

test('node comparisons follow tree order and containment through reordering and adoption', () => {
  const f=fixture(),d=f.document,main=d.querySelector('main'),a=d.querySelector('a'),b=d.querySelector('b');
  try {
    const nodes=[d,d.doctype,d.documentElement,d.head,d.body,main,a,a.firstChild,a.lastChild,b];
    for(let i=0;i<nodes.length;i++)for(let j=0;j<nodes.length;j++) {
      let node=nodes[j];while(node&&node!==nodes[i])node=node.parentNode;
      const contains=node===nodes[i];
      expect(containsNode(nodes[i],nodes[j])).toBe(contains);
      const expected=i===j?0:contains?20:containsNode(nodes[j],nodes[i])?10:i<j?4:2;
      expect(compareNodePosition(nodes[i],nodes[j])).toBe(expected);
    }
    main.prepend(b);expect(compareNodePosition(a,b)).toBe(2);expect(compareNodePosition(b,a)).toBe(4);
    b.append(a);expect(compareNodePosition(a,b)).toBe(10);expect(containsNode(b,a)).toBeTrue();
    const other=createDetachedDocument(f.window),root=other.createElement('root');other.append(root);
    root.append(other.adoptNode(a));
    expect(containsNode(d,a)).toBeFalse();expect(compareNodePosition(other,a)).toBe(20);
    expect(compareNodePosition(b,a)&33).toBe(33);
    d.body.append(a);expect(compareNodePosition(b,a)).toBe(4);
  } finally {f.window.happyDOM.close();}
});

test('disconnected comparisons are stable, antisymmetric and consistent for entire trees', () => {
  const f=fixture(),d=f.document;
  try {
    const roots=Array.from({length:3},()=>d.createDocumentFragment());
    for(const root of roots)root.append(d.createElement('x'),d.createTextNode('text'));
    const order=compareNodePosition(roots[0],roots[1]);
    expect([35,37]).toContain(order);
    for(let i=0;i<3;i++)for(let j=i+1;j<3;j++) {
      const result=compareNodePosition(roots[i],roots[j]);
      for(const a of [roots[i],...roots[i].childNodes])for(const b of [roots[j],...roots[j].childNodes]) {
        expect(compareNodePosition(a,b)).toBe(result);
        expect(compareNodePosition(b,a)).toBe(reverse(result));
        expect(containsNode(a,b)).toBeFalse();
      }
    }
    expect(compareNodePosition(roots[0],roots[1])).toBe(order);
    const host=d.createElement('div');d.body.append(host);
    const shadow=host.attachShadow({mode:'closed'}),child=d.createElement('i');shadow.append(child);
    expect(containsNode(host,child)).toBeFalse();expect(containsNode(shadow,child)).toBeTrue();
    expect(compareNodePosition(host,child)&33).toBe(33);
    expect(compareNodePosition(child,host)).toBe(reverse(compareNodePosition(host,child)));
    expect(compareNodePosition(shadow,child)).toBe(20);
  } finally {f.window.happyDOM.close();}
});

test('attributes use owner ordering without becoming children or losing detached identity', () => {
  const f=fixture(),d=f.document,owner=d.querySelector('main'),child=owner.firstChild;
  try {
    owner.setAttribute('x','');owner.setAttributeNS('urn:one','p:x','');owner.setAttributeNS('urn:two','p:x','');
    const [a,b,c]=owner.attributes;
    for(const attr of [a,b,c]) {
      expect(compareNodePosition(owner,attr)).toBe(20);expect(compareNodePosition(attr,owner)).toBe(10);
      expect(compareNodePosition(attr,child)).toBe(4);expect(compareNodePosition(child,attr)).toBe(2);
      expect(compareNodePosition(d,attr)).toBe(20);expect(compareNodePosition(attr,d)).toBe(10);
      expect(containsNode(owner,attr)).toBeFalse();expect(containsNode(d,attr)).toBeFalse();
      expect(containsNode(attr,attr)).toBeTrue();expect(compareNodePosition(attr,attr)).toBe(0);
    }
    expect(compareNodePosition(a,b)).toBe(36);expect(compareNodePosition(b,a)).toBe(34);
    expect(compareNodePosition(b,c)).toBe(36);expect(compareNodePosition(c,b)).toBe(34);
    owner.removeAttributeNode(b);expect(compareNodePosition(a,b)&33).toBe(33);
    expect(compareNodePosition(b,a)).toBe(reverse(compareNodePosition(a,b)));
    const unattached=d.createAttribute('other');
    expect(compareNodePosition(b,unattached)&33).toBe(33);
    expect(compareNodePosition(unattached,b)).toBe(reverse(compareNodePosition(b,unattached)));
    owner.setAttributeNodeNS(b);expect(compareNodePosition(c,b)).toBe(36);
    child.setAttributeNodeNS(owner.removeAttributeNode(b));
    expect(compareNodePosition(a,b)).toBe(4);expect(compareNodePosition(b,a)).toBe(2);
  } finally {f.window.happyDOM.close();}
});

test('comparison WebIDL validates brands and Node arguments with defining-realm errors', () => {
  const a=fixture(),b=fixture();class DefiningError extends TypeError {}
  const ar=new BindingRealm(a.window,{touch(){}}),br=new BindingRealm(b.window,{touch(){}}),prototype={};
  ar.inputValueIntrinsics={TypeError:DefiningError};installNodeComparisonMethods(prototype,ar);
  ar.inputValueIntrinsics.TypeError=class WrongError extends Error {};
  const node=br.wrap(b.document.body),child=br.wrap(b.document.querySelector('main'));
  try {
    const poison=new Proxy({}, {get(){throw Error('must not inspect or coerce author objects')}});
    for(const method of [prototype.contains,prototype.compareDocumentPosition]) {
      for(const receiver of [undefined,null,{},prototype,new Proxy(node,{})])
        expect(()=>method.call(receiver,poison)).toThrow(DefiningError);
      expect(()=>method.call(node)).toThrow(DefiningError);
      for(const value of [{},1,'node',false,Symbol(),1n,poison,new Proxy(child,{})])
        expect(()=>method.call(node,value)).toThrow(DefiningError);
      expect(method.name).toBe(method===prototype.contains?'contains':'compareDocumentPosition');
      expect(method.length).toBe(1);
    }
    for(const value of [null,undefined]) {
      expect(prototype.contains.call(node,value)).toBeFalse();
      expect(()=>prototype.compareDocumentPosition.call(node,value)).toThrow(DefiningError);
    }
    expect(prototype.contains.call(node,child)).toBeTrue();
    expect(prototype.compareDocumentPosition.call(node,child)).toBe(20);
    expect(prototype.contains.call(child,node)).toBeFalse();
    expect(prototype.compareDocumentPosition.call(child,node)).toBe(10);
    expect(prototype.contains.call(node,node,poison)).toBeTrue();
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('page node comparisons keep ordinary tree boundaries and captured intrinsics', async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://node-comparison.test/',contentType:'text/html',source:'<!doctype html><div id=host></div>'});await host.call('whenLoaded');
    expect(await host.call('evaluate',`(()=>{
      const out=[],host=document.getElementById('host'),a=document.createElement('a'),b=document.createElement('b');
      const disconnected=a.compareDocumentPosition(b);out.push([35,37].includes(disconnected),b.compareDocumentPosition(a)===(disconnected===35?37:35));
      host.append(a,b);out.push(a.compareDocumentPosition(b)===4,host.contains(a));host.prepend(b);out.push(a.compareDocumentPosition(b)===2);
      a.setAttribute('x','');const attr=a.getAttributeNode('x');out.push(a.compareDocumentPosition(attr)===20,attr.compareDocumentPosition(a)===10,!a.contains(attr));
      const shadow=host.attachShadow({mode:'closed'}),inside=document.createTextNode('shadow');shadow.append(inside);
      out.push(!host.contains(inside),shadow.contains(inside),(inside.compareDocumentPosition(host)&33)===33);
      const xml=new Document();xml.append(xml.adoptNode(a));out.push(xml.contains(a),!document.contains(a));
      const OriginalError=TypeError;globalThis.TypeError=function(){throw 'mutable global used'};
      for(const call of [()=>host.contains(),()=>host.contains({}),()=>host.compareDocumentPosition(null),()=>Node.prototype.contains.call({},host),()=>Node.prototype.compareDocumentPosition.call({},host)]) {
        try{call();out.push(false)}catch(e){out.push(e instanceof OriginalError)}
      }
      out.push(host.contains(undefined)===false);globalThis.TypeError=OriginalError;return out;
    })()`)).toEqual(Array(19).fill(true));
  } finally {await host.close();}
},30000);

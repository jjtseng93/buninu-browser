import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('DOM node constructors reuse node wrappers and support subclasses',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const r=[];
   for(const C of [Text,Comment]){
    const n=new C(null);r.push(n.data,n.ownerDocument===document,n instanceof C,n instanceof CharacterData,n instanceof Node);
    const f=new DocumentFragment();f.append(n);r.push(f.firstChild===n);document.body.append(f);r.push(n.parentNode===document.body,f.childNodes.length);
    class Derived extends C{};const d=new Derived('x');d.appendData('y');r.push(d instanceof Derived,d instanceof C,d.data);
    const sentinel={};try{new C({toString(){throw sentinel}})}catch(e){r.push(e===sentinel)}
    try{C()}catch(e){r.push(e.constructor===TypeError)}
   }
   const comment=document.createComment('x');r.push(Object.getPrototypeOf(comment)===Comment.prototype,Object.prototype.toString.call(comment));
   class Fragment extends DocumentFragment{};const f=new Fragment();f.append(new Text('ok'));r.push(f instanceof Fragment,f instanceof DocumentFragment,f.textContent);return r;
  })()`)).toEqual([...Array.from({length:2},()=>['null',true,true,true,true,true,true,0,true,true,'xy',true,true]).flat(),true,'[object Comment]',true,true,'ok']);
 }finally{await host.close();}
});

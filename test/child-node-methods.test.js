import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('ChildNode mutations work on text, comments, processing instructions and doctypes',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><body><div id="box"></div></body>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const box=document.getElementById('box'),r=[];
   for(const node of [document.createTextNode('x'),document.createComment('x'),document.createProcessingInstruction('foo','x')]){
    box.replaceChildren(node);node.before('a');node.after('b');r.push(box.childNodes.length,box.firstChild.data,box.lastChild.data);
    node.replaceWith('c');r.push(box.textContent);box.firstChild.remove();r.push(box.textContent);
   }
   const pi=document.createProcessingInstruction('foo','bar');r.push(pi instanceof ProcessingInstruction,pi instanceof CharacterData,pi.target,pi.data);
   const type=document.doctype;r.push(type instanceof DocumentType,type.name);type.remove();r.push(document.doctype===null);document.insertBefore(type,document.documentElement);r.push(document.doctype===type);
   r.push(typeof document.remove,typeof document.createDocumentFragment().before);
   return r;
  })()`)).toEqual([3,'a','b','acb','cb',3,'a','b','acb','cb',3,'a','b','acb','cb',true,true,'foo','bar',true,'html',true,true,'undefined','undefined']);
 }finally {await host.close();}
});

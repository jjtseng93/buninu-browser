import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('CharacterData element siblings update after moves and exclude DocumentType',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const box=document.querySelector('div'),left=document.createElement('i'),right=document.createElement('b'),r=[];
   for(const node of [document.createTextNode('x'),document.createComment('x'),document.createProcessingInstruction('foo','bar')]){
    box.replaceChildren(left,document.createTextNode('skip'),node,document.createComment('skip'),right);
    r.push(node.previousElementSibling===left,node.nextElementSibling===right);
    right.remove();r.push(node.nextElementSibling===null);node.remove();r.push(node.previousElementSibling===null,node.nextElementSibling===null);
   }
   r.push('nextElementSibling' in document.doctype,'previousElementSibling' in document);return r;
  })()`)).toEqual([...Array.from({length:3},()=>[true,true,true,true,true]).flat(),false,false]);
 }finally{await host.close();}
});

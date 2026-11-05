import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('CharacterData mutates real nodes, reports mutations and wraps split siblings',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div id="box">hello</div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const box=document.getElementById('box'),text=box.firstChild,observer=new MutationObserver(()=>{});observer.observe(text,{characterData:true,characterDataOldValue:true});text.appendData('!');text.insertData(0,'A');text.deleteData(1,1);text.replaceData(1,2,'xy');const before=text.data,records=observer.takeRecords().map(r=>r.oldValue),next=text.splitText(3);const r=[before,records,text.data,next.data,next===text.nextSibling,next.parentNode===box,text.wholeText];const u=document.createTextNode('a😀b');r.push(u.length,u.substringData(1,2),u.substringData(4294967296,1));try{u.deleteData(-1,1)}catch(e){r.push(e.name)}try{u.replaceData(0,1,Symbol())}catch(e){r.push(e.name)}u.data=null;r.push(u.data);try{u.appendData()}catch(e){r.push(e.constructor===TypeError)}return r})()`)).toEqual(['Axylo!',['hello','hello!','Ahello!','Aello!'],'Axy','lo!',true,true,'Axylo!',4,'😀','a','IndexSizeError','TypeError','',true]);
 }finally{await host.close();}
});

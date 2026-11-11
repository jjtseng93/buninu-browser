import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('unknown pseudo-classes throw before matching, with forgiving is/where branches',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div class="x" data-value=":visible"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const el=document.querySelector('.x'),r=[];
   for(const selector of [':visible',':hidden',':first','.absent:unknown',':not(:unknown)',':has(:unknown)',':checked(1)'])
    for(const [node,method] of [[el,'matches'],[el,'closest'],[el,'querySelector'],[document,'querySelectorAll'],[document.createDocumentFragment(),'querySelector']]){
     try{node[method](selector);r.push(false)}catch(e){r.push(e.name==='SyntaxError'&&e instanceof DOMException)}
    }
   return [r.every(Boolean),r.length,document.querySelectorAll(':is(:unknown,.x)').length,
    document.querySelectorAll(':where(:not(:unknown),.x)').length,document.querySelectorAll(':is(:unknown)').length,
    document.querySelectorAll('[data-value=":visible"]').length];
  })()`)).toEqual([true,35,1,1,0,1]);
 }finally {await host.close();}
});
test('selector APIs share the alias and expose standard parser and conversion exceptions',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><div class="x"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const el=document.querySelector('.x'),r=[el.matches===el.webkitMatchesSelector,el.matches.name,el.webkitMatchesSelector('.x'),typeof document.webkitMatchesSelector];
   for(const [node,method] of [[el,'matches'],[el,'closest'],[el,'querySelector'],[document,'querySelectorAll'],[document.createDocumentFragment(),'querySelector']]){
    try{node[method]('[')}catch(e){r.push(e.name,e.code,e instanceof DOMException)}
    try{node[method]()}catch(e){r.push(e.constructor===TypeError)}
    try{node[method](Symbol())}catch(e){r.push(e.constructor===TypeError)}
    const sent=new TypeError('page');try{node[method]({toString(){throw sent}})}catch(e){r.push(e===sent)}
   }
   return r;
  })()`)).toEqual([true,'matches',true,'undefined',...Array.from({length:5},()=>['SyntaxError',12,true,true,true,true]).flat()]);
 }finally {await host.close();}
});

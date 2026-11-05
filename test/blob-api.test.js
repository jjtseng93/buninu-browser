import {test,expect} from 'bun:test';
import {blobInterface,createNativeBlob,createNativeFile,blobEndings} from '../lib/renderer/blob.js';
import {formDataInterface} from '../lib/renderer/form-data.js';
import {RendererHost} from '../lib/renderer/host.js';

test('Blob and File MIME types stay exact in native BodyInit slots',async()=>{
 const {Blob}=blobInterface();
 for(const type of ['text/plain','application/json','TEXT/HTML','text/plain;charset=windows-1252','text/plain; X="AbC"','text/plain ','','foo','\u00df','x\n']){
  const expected=/[^\x20-\x7e]/.test(type)?'':type.toLowerCase();
  const blob=new Blob(['bytes'],{type}),file=createNativeFile(['bytes'],'a.txt',{type});
  expect(blob.type).toBe(expected);expect(file.type).toBe(expected);
  expect(new Response(blob).headers.get('content-type')).toBe(expected?expected.trim():null);
  expect(new Request('https://test.invalid/',{method:'POST',body:blob}).headers.get('content-type')).toBe(expected?expected.trim():null);
  const form=new FormData();form.append('f',file);
  expect(await new Response(form).text()).toContain('Content-Type: '+(expected||'application/octet-stream'));
 }
});

test('Blob constructor observes sequence and dictionary order and normalizes each string part',async()=>{
 const {Blob}=blobInterface();const order=[];
 const parts={*[Symbol.iterator](){order.push('iterator');yield {toString(){order.push('part');return 'a\r'}};yield '\nb';yield new Uint8Array([13,10]);}};
 const blob=new Blob(parts,{get endings(){order.push('endings');return 'native'},get type(){order.push('type');return 'text/plain'}});
 expect(order).toEqual(['iterator','part','endings','type']);
 expect(await blob.text()).toBe(process.platform==='win32'?'a\r\n\r\nb\r\n':'a\n\nb\r\n');
 expect(await new Blob(new Uint8Array([1,2,3])).text()).toBe('123');
 expect(await new Blob(['\ud800','\udc00']).text()).toBe('\ufffd\ufffd');
 expect(blobEndings(['\r','\n',new Uint8Array([13])],'transparent')[0]).toBe('\r');
});

test('Blob slice uses ties-to-even offsets and does not inherit the original MIME',async()=>{
 const api=blobInterface(),blob=new api.Blob(['abcd'],{type:'text/plain'});
 for(const [start,end,expected] of [[1.5,undefined,'cd'],[2.5,undefined,'cd'],[3.5,undefined,''],[0,.5,''],[0,1.5,'ab'],[-1.5,undefined,'cd'],[-2.5,undefined,'cd'],[-Infinity,Infinity,'abcd']]){
  const slice=blob.slice(start,end);expect(slice.type).toBe('');expect(await slice.text()).toBe(expected);expect(slice.constructor).toBe(api.Blob);
 }
 expect(blob.slice(0,0,null).type).toBe('null');expect(blob.slice(0,1,'TEXT/PLAIN').type).toBe('text/plain');
 const legacy=new globalThis.Blob(['abc'],{type:'text/plain'});
 expect(api.Blob.prototype.slice.call(legacy).type).toBe('');
 expect(createNativeBlob([legacy],'').type).toBe('');
});

test('Blob conversions use the defining realm and preserve author exceptions',()=>{
 class PageError extends TypeError{}
 const api=blobInterface();api.initialize({TypeError:PageError});
 for(const value of [null,false,1,1n,'str',{},new Date()])expect(()=>new api.Blob(value)).toThrow(PageError);
 for(const value of [null,'','Native',Symbol()])expect(()=>new api.Blob([],{endings:value})).toThrow(PageError);
 for(const value of [{[Symbol.iterator](){return 1}},{[Symbol.iterator](){return {next:1}}},{[Symbol.iterator](){return {next(){return 1}}}}])expect(()=>new api.Blob(value)).toThrow(PageError);
 const sentinel=new TypeError('author');let caught;
 try{new api.Blob([{toString(){throw sentinel}}])}catch(error){caught=error}expect(caught).toBe(sentinel);
 let reads=0;const Target=new Proxy(function(){},{get(target,key){if(key==='prototype'){reads++;return api.Blob.prototype;}return Reflect.get(target,key)}});
 expect(Reflect.construct(api.Blob,[[]],Target).constructor).toBe(api.Blob);expect(reads).toBe(1);
 const blob=new api.Blob(['abc']);for(const value of [1n,Symbol(),Object(1n)])expect(()=>blob.slice(value)).toThrow(PageError);
 let converted=false;expect(()=>api.Blob.prototype.slice.call({}, {valueOf(){converted=true;return 1}})).toThrow(PageError);expect(converted).toBeFalse();
});

test('Blob and File reject shared or resizable BufferSources during sequence conversion',async()=>{
 class PageError extends TypeError{}
 const blobs=blobInterface(),forms=formDataInterface({blobs});forms.initialize({TypeError:PageError,DOMException,Array,Object});
 const shared=new SharedArrayBuffer(4),resizable=new ArrayBuffer(4,{maxByteLength:8});
 for(const part of [new Uint8Array(shared),new DataView(shared),resizable,new Uint8Array(resizable),new DataView(resizable)]){
  for(const make of [parts=>new blobs.Blob(parts),parts=>new forms.File(parts,'name')]){
   let closed=false;const parts={*[Symbol.iterator](){try{yield part}finally{closed=true}}};
   expect(()=>make(parts)).toThrow(PageError);expect(closed).toBeFalse();
  }
 }
 expect(await new blobs.Blob([shared]).text()).toBe('[object SharedArrayBuffer]');
 const fixed=new Uint8Array([65]);Object.defineProperty(fixed,'buffer',{get(){throw Error('author buffer')}});
 expect(await new blobs.Blob([fixed]).text()).toBe('A');
 const file=new forms.File(['a\r','\nb'],'name',{type:'text/plain',endings:'native',lastModified:12.9});
 expect(Object.getPrototypeOf(forms.File)).toBe(blobs.Blob);expect(Object.getPrototypeOf(forms.File.prototype)).toBe(blobs.Blob.prototype);
 expect(file instanceof blobs.Blob).toBeTrue();expect(file.type).toBe('text/plain');expect(file.lastModified).toBe(12);
 expect(await file.text()).toBe(process.platform==='win32'?'a\r\n\r\nb':'a\n\nb');
 expect(file.slice().constructor).toBe(blobs.Blob);
});

test('Blob methods are own nonconstructible operations with defining-realm errors',async()=>{
 class PageError extends TypeError{}
 class PagePromise extends Promise{}
 const api=blobInterface();api.initialize({TypeError:PageError,Object,Promise:PagePromise});
 PagePromise.resolve=PagePromise.reject=()=>{throw Error('author Promise property')};
 expect(Object.getPrototypeOf(api.Blob.prototype)).toBe(Object.prototype);
 for(const name of ['slice','stream','text','arrayBuffer','bytes']){
  expect(Object.getOwnPropertyDescriptor(api.Blob.prototype,name).enumerable).toBeTrue();
  expect(Object.hasOwn(api.Blob.prototype[name],'prototype')).toBeFalse();
 }
 expect(()=>api.Blob.prototype.stream.call({})).toThrow(PageError);
 for(const name of ['text','arrayBuffer','bytes'])await expect(api.Blob.prototype[name].call({})).rejects.toBeInstanceOf(PageError);
 expect(await new api.Blob(['bytes']).text()).toBe('bytes');
});

test('Blob construction, slicing and Body results do not inherit native File identity',async()=>{
 const blobs=blobInterface(),forms=formDataInterface({blobs}),file=new forms.File(['abc'],'source.txt',{type:'text/plain',lastModified:42});
 for(const blob of [new blobs.Blob([file],{type:'text/plain'}),file.slice(),new blobs.Blob([file]).slice(),blobs.expose(await new Response(file).blob()),blobs.expose(await new Request('https://test.invalid/',{method:'POST',body:file}).blob())]){
  expect(blob.constructor).toBe(blobs.Blob);expect(await blob.text()).toBe('abc');
  const data=new forms.FormData();data.append('value',blob);
  expect(data.get('value')).not.toBe(blob);expect(data.get('value').name).toBe('blob');
  const clone=blobs.exposeClonedData(structuredClone(blob),forms.exposeFile);
  expect(clone.constructor).toBe(blobs.Blob);expect(clone instanceof forms.File).toBeFalse();
 }
});

test('native clone result exposure preserves Blob/File data, graph identity and opaque values',async()=>{
 const blobs=blobInterface(),forms=formDataInterface({blobs});
 const b=new blobs.Blob(['body'],{type:'text/plain'}),f=new forms.File(['file'],'name',{lastModified:42,type:'application/json'});
 const source={b,f,array:[b,f],map:new Map([[b,f]]),set:new Set([b,f]),bytes:new Uint8Array([1,2]),date:new Date(123)};source.self=source;
 const clone=blobs.exposeClonedData(structuredClone(source),forms.exposeFile);
 expect(clone.self).toBe(clone);expect(clone.array).toEqual([clone.b,clone.f]);expect(clone.map.get(clone.b)).toBe(clone.f);expect([...clone.set]).toEqual(clone.array);
 expect(clone.b.constructor).toBe(blobs.Blob);expect(clone.f.constructor).toBe(forms.File);expect(clone.f instanceof blobs.Blob).toBeTrue();
 expect([clone.b.type,clone.f.type,clone.f.name,clone.f.lastModified]).toEqual(['text/plain','application/json','name',42]);
 expect(await clone.b.text()).toBe('body');expect(await clone.f.text()).toBe('file');expect([...clone.bytes]).toEqual([1,2]);expect(clone.date.getTime()).toBe(123);
});

test('page Blob and File keep native body slots and expose API results with page prototypes',async()=>{
 const requests=[];
 const host=new RendererHost({fetch:async(url,init)=>{requests.push(init);return new Response('reply',{headers:{'content-type':'text/plain'}});}});
 try{
  await host.start();await host.call('loadDocument',{url:'https://blob.test/',contentType:'text/html',source:'<!doctype html><canvas id=c width=1 height=1></canvas>'});await host.call('whenLoaded');
  const run=source=>host.call('evaluate',source);
  expect(await run(`(()=>{const b=new Blob(['x'],{type:'text/plain'}),f=new File(['x'],'name',{type:'text/plain'}),fd=new FormData();fd.set('b',b);return [Object.getPrototypeOf(File)===Blob,Object.getPrototypeOf(File.prototype)===Blob.prototype,f instanceof Blob,f.slice().constructor===Blob,fd.get('b').type,new Request('/body',{method:'POST',body:b}).headers.get('content-type'),new Response(b).headers.get('content-type')]})()`)).toEqual([true,true,true,true,'text/plain','text/plain','text/plain']);
  expect(await run(`Promise.all([new Response(new Blob(['response'])).blob(),new Request('/body',{method:'POST',body:new Blob(['request'])}).blob(),fetch('/fetch').then(r=>r.blob()),new Promise(resolve=>c.toBlob(resolve))]).then(values=>values.map(b=>[b instanceof Blob,b.constructor===Blob,b.slice().constructor===Blob]))`)).toEqual(Array(4).fill([true,true,true]));
  expect(await run(`(()=>{const marker={},observed=[];try{new Blob([{toString(){throw marker}}])}catch(e){observed.push(e===marker)}try{new Blob(null)}catch(e){observed.push(Object.getPrototypeOf(e)===TypeError.prototype)}try{Blob.prototype.slice.call({})}catch(e){observed.push(Object.getPrototypeOf(e)===TypeError.prototype)}return observed})()`)).toEqual([true,true,true]);
  expect(await run(`(()=>{const b=structuredClone(new Blob(['copy'],{type:'text/plain'})),f=structuredClone(new File(['file'],'f',{lastModified:19}));return [b instanceof Blob,b.constructor===Blob,b.type,f instanceof File,f instanceof Blob,f.name,f.lastModified,Object.getPrototypeOf(Blob.prototype)===Object.prototype,new Blob().text() instanceof Promise]})()`)).toEqual([true,true,'text/plain',true,true,'f',19,true,true]);
  expect(await run(`Promise.all([new Response(new File(['a'],'r')).blob(),new Request('/body',{method:'POST',body:new File(['a'],'q')}).blob()]).then(values=>values.map(b=>{const d=new FormData();d.set('b',b);return [b.constructor===Blob,structuredClone(b).constructor===Blob,d.get('b').name]}))`)).toEqual([[true,true,'blob'],[true,true,'blob']]);
  expect(await run(`new Promise(resolve=>{const channel=new MessageChannel(),b=new Blob(['message'],{type:'text/plain'}),f=new File(['file'],'message.txt',{lastModified:21}),bytes=new Uint8Array([9]);const data={b,f,bytes,map:new Map([[b,f]]),set:new Set([b,f])};data.self=data;channel.port1.onmessage=async e=>{const d=e.data;channel.port1.close();channel.port2.close();resolve([d.b instanceof Blob,d.f instanceof File,d.f instanceof Blob,d.f.name,d.f.lastModified,await d.b.text(),d.b.type,d.map.get(d.b)===d.f,d.set.has(d.f),d.self===d,d.bytes[0],bytes.byteLength])};channel.port2.postMessage(data,[bytes.buffer])})`)).toEqual([true,true,true,'message.txt',21,'message','text/plain',true,true,true,9,0]);
  await run(`fetch('/upload',{method:'POST',body:new Blob(['exact body'],{type:'text/plain'})})`);
  expect(new Headers(requests.at(-1).headers).get('content-type')).toBe('text/plain');expect(new TextDecoder().decode(requests.at(-1).body)).toBe('exact body');
 }finally{host.close();}
},30000);

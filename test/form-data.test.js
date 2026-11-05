import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {formDataInterface} from '../lib/renderer/form-data.js';
import {RendererHost} from '../lib/renderer/host.js';

const html='http://www.w3.org/1999/xhtml';
const apiFor=document=>formDataInterface({unwrap:value=>value?.ownerDocument===document?value:null});

test('FormData entries share ownership, actual disabledness, select options, files and scalar strings',()=>{
 const {document,window}=parseHTMLDocument(`<input name=external value=outside form=f><form id=f><fieldset disabled><legend><input name=legend value=yes></legend><input name=no value=no></fieldset><datalist><input name=no value=no></datalist><select name=s multiple><option selected>A</option><option disabled selected>B</option><optgroup disabled><option selected>C</option></optgroup><option selected>D</option></select><input type=checkbox name=c checked><textarea name=t>a\nb</textarea><input name=f type=file><input name=_charset_ type=hidden value=wrong><input name=text dirname=direction dir=rtl value=abc><button name=button value=''></button><input type=image name=image></form>`);
 try{
  const api=apiFor(document),form=document.getElementById('f'),d=new api.FormData(form,form.querySelector('button'));
  expect([...d].filter(([name])=>name!=='f')).toEqual([['external','outside'],['legend','yes'],['s','A'],['s','D'],['c','on'],['t','a\nb'],['_charset_','UTF-8'],['text','abc'],['direction','rtl'],['button','']]);
  expect(d.get('f').constructor).toBe(api.File);expect(d.get('f')).toBe(d.getAll('f')[0]);expect(d.get('f').size).toBe(0);
  const image=form.querySelector('[type=image]');expect([...new api.FormData(form,image)].slice(-2)).toEqual([['image.x','0'],['image.y','0']]);
  expect(()=>new api.FormData(null)).toThrow(TypeError);expect(()=>new api.FormData(form,document.createElement('div'))).toThrow(TypeError);
  const other=document.createElement('button');expect(()=>new api.FormData(form,other)).toThrow(expect.objectContaining({name:'NotFoundError'}));
  const x=document.createElement('input');x.name='n\ud800';x.value='v\udc00';form.append(x);expect(new api.FormData(form).get('n\ufffd')).toBe('v\ufffd');
 }finally{window.happyDOM.close();}
});

test('FormData mutation identity and native body slots stay synchronized without author iterators',async()=>{
 const api=formDataInterface(),d=new api.FormData(),file=new api.File(['hello'],'a.txt',{lastModified:123,type:'text/plain'});
 d.append('file',file);expect(d.get('file')).toBe(file);expect(d.getAll('file')[0]).toBe(file);
 d.append('blob',new Blob(['B']));expect(d.get('blob').constructor).toBe(api.File);expect(d.get('blob')).toBe(d.get('blob'));
 d.set('renamed',file,'new.txt');expect(d.get('renamed').name).toBe('new.txt');expect(d.get('renamed').lastModified).toBe(123);
 d.append('x','1');d.append('y','2');d.append('x','3');d.set('x','4');expect([...d].slice(-2)).toEqual([['x','4'],['y','2']]);
 d.delete('y');expect(d.has('y')).toBeFalse();d[Symbol.iterator]=()=>{throw Error('must not use page iterator')};
 const text=await new Response(d).text();expect(text).toContain('hello');expect(text).toContain('name="x"');expect(text).not.toContain('name="y"');
 expect(()=>api.FormData.prototype.get.call({},'a')).toThrow(TypeError);
 expect(()=>d.append('a','text','filename')).toThrow(TypeError);
 const sentinel={};let caught;try{d.get({toString(){throw sentinel}})}catch(e){caught=e}expect(caught).toBe(sentinel);
});

test('FormData events are trusted, share mutations during dispatch, prevent reentry and snapshot afterward',()=>{
 const {document,window}=parseHTMLDocument('<form><input name=x value=1></form>');
 try{
  const api=apiFor(document),form=document.querySelector('form');let eventData;
  form.addEventListener('formdata',event=>{eventData=event;expect(()=>new api.FormData(form)).toThrow(expect.objectContaining({name:'InvalidStateError'}));});
  // Native listeners do not receive page wrappers; event metadata is intentionally private.
  const d=new api.FormData(form);expect(d.get('x')).toBe('1');expect(eventData.type).toBe('formdata');
 }finally{window.happyDOM.close();}
});

test('page FormData/File/Event work with AJAX and normal form submission',async()=>{
 const requests=[],navigations=[];
 const host=new RendererHost({onNavigate:(...args)=>navigations.push(args),fetch:async (url,init)=>{requests.push({url,...init});return new Response('OK',{headers:{'content-type':'text/plain'}});}});
 try{
  await host.start();await host.call('loadDocument',{url:'https://forms.test/',contentType:'text/html',source:'<form id=f action="/submit"><input name=x value=1><input name=no disabled value=2><select name=s multiple><option selected>A</option><option selected>B</option></select></form>'});await host.call('whenLoaded');
  const run=code=>host.call('evaluate',code);
  expect(await run(`(()=>{let ev;f.onformdata=e=>{ev=e;e.formData.append('extra','yes');try{new FormData(f)}catch(x){window.reentry=x.name}};const d=new FormData(f);ev.formData.append('later','no');return [d.get('x'),d.getAll('s'),d.get('extra'),d.has('later'),ev instanceof FormDataEvent,ev instanceof Event,ev.isTrusted,reentry]})()`)).toEqual(['1',['A','B'],'yes',false,true,true,true,'InvalidStateError']);
  expect(await run(`(()=>{const fd=new FormData();const file=new File(['abc'],'a.txt');fd.append('a',file);return [file.constructor===File,fd.get('a')===file,fd.getAll('a')[0]===file,new FormDataEvent('e',{formData:fd}).formData===fd]})()`)).toEqual([true,true,true,true]);
  expect(await run(`(()=>{try{new FormData(null)}catch(e){return Object.getPrototypeOf(e)===TypeError.prototype}})()`)).toBeTrue();
  await run(`window.done=false;const d=new FormData(f);d[Symbol.iterator]=()=>{throw Error('bad iterator')};fetch('/ajax',{method:'POST',body:d}).then(r=>r.text()).then(v=>{window.answer=v;window.done=true})`);
  for(let n=0;n<100&&!await run('done');n++)await Bun.sleep(10);expect(await run('answer')).toBe('OK');
  expect(new TextDecoder().decode(requests[0].body)).toContain('name="extra"');
  await run('f.submit()');expect(navigations.length).toBe(1);expect(navigations[0][0]).toContain('x=1&s=A&s=B&extra=yes');
  await run(`window.requestDone=false;const fd=new FormData();fd.append('payload',new File(['file bytes'],'upload.txt',{type:'application/octet-stream'}));const request=new Request('/request',{method:'POST',body:fd});fetch(request).then(()=>window.requestDone=true)`);
  for(let n=0;n<100&&!await run('requestDone');n++)await Bun.sleep(10);expect(await run('requestDone')).toBeTrue();expect(new TextDecoder().decode(requests.at(-1).body)).toContain('file bytes');
  await run(`window.xhrDone=false;const xhr=new XMLHttpRequest();xhr.open('POST','/xhr');xhr.onload=()=>window.xhrDone=true;xhr.send(new FormData(f))`);
  for(let n=0;n<100&&!await run('xhrDone');n++)await Bun.sleep(10);expect(await run('xhrDone')).toBeTrue();expect(new TextDecoder().decode(requests.at(-1).body)).toContain('name="extra"');
  await run(`f.onformdata=e=>{f.method='POST';f.action='/changed';f.enctype='multipart/form-data';e.formData.append('file',new File(['actual selected bytes'],'photo.bin'))};f.submit()`);
  for(let n=0;n<100&&navigations.length<2;n++)await Bun.sleep(10);expect(navigations[1][0]).toBe('https://forms.test/changed');expect(new TextDecoder().decode(navigations[1][3].body)).toContain('actual selected bytes');
  await run(`f.onformdata=e=>e.formData.append('file',new File(['bytes'],'x'));f.action='/obsolete';f.submit();location.href='/newer'`);await Bun.sleep(30);
  expect(navigations.slice(2).map(item=>item[0])).toEqual(['https://forms.test/newer']);
  await run(`f.action='/first';f.submit();f.action='/last';f.submit()`);await Bun.sleep(30);
  expect(navigations.slice(3).map(item=>item[0])).toEqual(['https://forms.test/last']);
  await run(`f.onformdata=()=>f.remove();f.submit()`);await Bun.sleep(30);expect(navigations.length).toBe(4);

 }finally{host.close();}
},30000);

test('FormData/File conversions preserve defining realm, author errors, subclass identity and live iteration',()=>{
 class PageError extends TypeError {}
 const api=formDataInterface();api.initialize({TypeError:PageError,DOMException,Array,Object});
 for(const value of [Object(1n),Object(Symbol()),{valueOf(){return 1n}},{[Symbol.toPrimitive](){return {}}}])expect(()=>new api.File([],'x',{lastModified:value})).toThrow(PageError);
 for(const [value,expected] of [[Infinity,0],[-Infinity,0],[-1.5,-1],[2**64,0],[2**63,-(2**63)]])expect(new api.File([],'x',{lastModified:value}).lastModified).toBe(expected);
 for(const value of [{[Symbol.iterator](){return 1}},{[Symbol.iterator](){return {next:1}}},{[Symbol.iterator](){return {next(){return 1}}}}])expect(()=>new api.File(value,'x')).toThrow(PageError);
 const sentinel=new TypeError('author');let caught;
 try{new api.File([],'x',{lastModified:{valueOf(){throw sentinel}}})}catch(e){caught=e}expect(caught).toBe(sentinel);
 let reads=0;const Target=new Proxy(function(){},{get(target,key){if(key==='prototype'){reads++;return api.File.prototype;}return Reflect.get(target,key)}});
 expect(Reflect.construct(api.File,[[],'x'],Target).constructor).toBe(api.File);expect(reads).toBe(1);
 const BadTarget=new Proxy(function(){},{get(target,key){if(key==='prototype')throw sentinel;return Reflect.get(target,key)}});
 try{Reflect.construct(api.File,[[],'x'],BadTarget)}catch(e){caught=e}expect(caught).toBe(sentinel);
 class Sub extends api.FormData{}const d=new Sub();expect(d instanceof Sub).toBeTrue();
 d.append('a','1');d.append('b','2');const seen=[];d.forEach((value,name)=>{seen.push([name,value]);if(name==='a'){d.delete('b');d.append('c','3')}});expect(seen).toEqual([['a','1'],['c','3']]);
 const iterator=d.entries();expect(iterator.next().value).toEqual(['a','1']);d.append('d','4');expect([...iterator]).toEqual([['c','3'],['d','4']]);d.append('e','5');expect(iterator.next().done).toBeTrue();
 d.append({toString(){d.delete('a');return 'a'}},'new');expect([...d].at(-1)).toEqual(['a','new']);
});

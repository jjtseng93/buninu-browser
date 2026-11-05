import {expect, test} from 'bun:test';
import {xhrBody} from '../lib/renderer/xhr-body.js';

test('XHR body extraction snapshots views and measures UTF-8 bytes without authored Blob getters', async () => {
  expect(xhrBody(null)).toEqual({body:null,length:0,type:null});
  const text=xhrBody('牛\ud800');
  expect(text.length).toBe(6);expect(await text.body.text()).toBe('牛�');
  const array=Uint8Array.from([1,2,3,4]), view=new DataView(array.buffer,1,2), data=xhrBody(view);
  array.fill(9);expect([...await data.body.bytes()]).toEqual([2,3]);expect(data.type).toBeNull();
  const blob=new Blob(['hello'],{type:'application/x-upload'});
  Object.defineProperties(blob,{size:{get(){throw Error('authored size')}},type:{get(){throw Error('authored type')}}});
  const result=xhrBody(blob);expect(result.length).toBe(5);expect(result.type).toBe('application/x-upload');
  const params=xhrBody(new URLSearchParams({a:'b c'}));expect(params.type).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  expect(await params.body.text()).toBe('a=b+c');
  const sentinel=Error('author conversion');expect(()=>xhrBody({toString(){throw sentinel}})).toThrow(sentinel);
  expect(()=>xhrBody(Symbol())).toThrow(TypeError);
  const shared=new SharedArrayBuffer(8),resizable=new ArrayBuffer(8,{maxByteLength:16});
  for(const value of [shared,new Uint8Array(shared),new DataView(shared),resizable,new Uint8Array(resizable)])
    expect(()=>xhrBody(value)).toThrow(TypeError);
});

test('XHR multipart extraction preserves files, normalizes line endings, and snapshots entries', async () => {
  const form=new FormData();form.append('a\n"b','one\rtwo');form.append('file',new File(['牛'],'hello.txt',{type:'application/x-upload'}));
  const result=xhrBody(form);form.set('file','changed');form.append('extra','late');
  expect(result.length).toBe((await result.body.bytes()).length);
  const text=await result.body.text();expect(text).toContain('name="a%0D%0A%22b"');expect(text).toContain('one\r\ntwo');
  const parsed=await new Response(result.body,{headers:{'content-type':result.type}}).formData();
  expect(parsed.get('a%0D%0A%22b')).toBe('one\r\ntwo');expect(parsed.get('extra')).toBeNull();
  expect(parsed.get('file').name).toBe('hello.txt');expect(await parsed.get('file').text()).toBe('牛');
});

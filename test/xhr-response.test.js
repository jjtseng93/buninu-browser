import {afterAll, beforeAll, expect, test} from 'bun:test';
import {decodeXHRResponse, xhrOverrideMimeType, xhrResponseMetadata, xhrResponseBlob} from '../lib/renderer/xhr-response.js';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';

test('XHR MIME overrides retain response charset unless they supply their own', () => {
  const original = 'text/html;charset=windows-1252';
  const metadata = value => xhrResponseMetadata(original, value === null ? null : xhrOverrideMimeType(value));
  expect(metadata(null)).toEqual({mimeType:original,essence:'text/html',encoding:'windows-1252'});
  expect(metadata('TEXT/PLAIN')).toEqual({mimeType:'text/plain',essence:'text/plain',encoding:'windows-1252'});
  expect(metadata('bogus;charset=Shift_JIS')).toEqual({mimeType:'application/octet-stream',essence:'application/octet-stream',encoding:'windows-1252'});
  expect(metadata('text/plain;charset=invalid').encoding).toBeNull();
  expect(metadata('text/plain;charset=Shift-JIS').encoding).toBe('shift_jis');
  expect(xhrResponseMetadata(null).mimeType).toBe('text/xml');
  expect(xhrResponseMetadata('').mimeType).toBe('text/xml');
  expect(xhrResponseMetadata('bad').mimeType).toBe('text/xml');
  expect(xhrOverrideMimeType('text/plain;charset="utf-8";charset=windows-1252').toString()).toBe('text/plain;charset=utf-8');
});

test('XHR decoding honors BOM, legacy encodings and XML-only sniffing; JSON remains UTF-8', () => {
  const decode = (bytes, type, responseType = '') => decodeXHRResponse(Uint8Array.from(bytes),responseType,xhrResponseMetadata(type));
  expect(decode([0x83,0x65,0x83,0x58,0x83,0x67],'text/plain;charset=Shift_JIS')).toBe('テスト');
  expect(decode([0xff],'text/plain;charset=windows-1252')).toBe('ÿ');
  expect(decode([0xff],'text/plain;charset=bogus')).toBe('\ufffd');
  expect(decode([0xef,0xbb,0xbf,0xc3,0xa9],'text/plain;charset=windows-1252')).toBe('é');
  expect(decode([0xfe,0xff,0x00,0xe9],'text/plain;charset=utf-8','text')).toBe('é');
  expect(decode([0xff,0xfe,0xe9,0x00],'text/plain;charset=windows-1252')).toBe('é');
  expect(decode([0xef,0xbb,0xbf,0xef,0xbb,0xbf],'text/plain')).toBe('\ufeff');
  expect(decode([1,2,3],'text/plain;charset=iso-2022-kr')).toBe('\ufffd');
  const xml = '<?xml version="1.0" encoding="windows-1252"?><x>ÿ</x>';
  const raw = Uint8Array.from([...xml],c=>c.charCodeAt(0));
  expect(decode(raw,'application/custom+xml')).toBe(xml);
  expect(decode(raw,'text/html')).toBe(xml.replace('ÿ','\ufffd'));
  expect(decode(raw,'application/xml','text')).toBe(xml.replace('ÿ','\ufffd'));
  expect(decode(raw,'application/xml;charset=utf-8')).toBe(xml.replace('ÿ','\ufffd'));
  expect(decode(new TextEncoder().encode('"é"'),'application/json;charset=Shift_JIS','json')).toBe('"é"');
  expect(decode([0xff,0xfe,0x22,0,0x22,0],'application/json','json')).not.toBe('""');
  const offset = Uint8Array.from([0,0,0xff,0,0]);
  expect(decodeXHRResponse(offset.subarray(2,3),'text',xhrResponseMetadata('text/plain;charset=windows-1252'))).toBe('ÿ');
  const malformed = new TextEncoder().encode('<?xml'+'x'.repeat(2_000_000));
  expect(decodeXHRResponse(malformed,'',xhrResponseMetadata('text/xml'))).toHaveLength(malformed.length);
});

test('XHR blob types retain the parsed MIME record without constructor normalization', async () => {
  for (const mime of ['text/html','text/plain;charset=GBK','text/html;test="ÿ";charset=gbk']) {
    const blob = xhrResponseBlob(Uint8Array.of(255,0,128),xhrResponseMetadata(mime));
    expect(blob instanceof Blob).toBeTrue();
    expect(blob.type).toBe(mime);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([255,0,128]);
  }
});

let renderer;
const requests = [];
beforeAll(async () => {
  const network = new NetworkService({fetch:async(url, init) => {
    const path = new URL(url).pathname;
    requests.push({path,method:init.method});
    if (path === '/shift-jis') return new Response(Uint8Array.from([0x83,0x65,0x83,0x58,0x83,0x67]),{headers:{'content-type':'text/plain;charset=windows-1252','x-original':'yes'}});
    if (path === '/json') return new Response('"テスト"',{headers:{'content-type':'application/json;charset=windows-1252'}});
    return new Response(Uint8Array.from([0xff,0x41]),{headers:{'content-type':'text/plain;charset=windows-1252'}});
  }});
  renderer = new RendererHost({network,timeout:20_000});
  await renderer.start();
  await renderer.call('loadDocument',{url:'https://xhr.test/',contentType:'text/html',status:200,source:'<!doctype html><p>XHR</p>'});
});
afterAll(()=>renderer?.close());
const evaluate = source => renderer.call('evaluate',source);

test('XHR override works before open and at headers without altering response headers', async () => {
  const result = await evaluate(`Promise.all([0,1,2].map(state=>new Promise((resolve,reject)=>{
    const x=new XMLHttpRequest(), states=[];
    if(state===0)x.overrideMimeType('text/plain;charset=Shift_JIS');
    x.onreadystatechange=()=>{states.push(x.readyState);if(x.readyState===2&&state===2)x.overrideMimeType('text/plain;charset=Shift_JIS')};
    x.open('GET','/shift-jis');
    if(state===1)x.overrideMimeType('text/plain;charset=Shift_JIS');
    x.onload=()=>resolve({text:x.responseText,response:x.response,states,header:x.getResponseHeader('content-type')});
    x.onerror=reject;x.send();
  })))`);
  expect(result).toEqual([0,1,2].map(()=>({text:'テスト',response:'テスト',states:[1,2,3,4],header:'text/plain;charset=windows-1252'})));
  expect(requests.filter(request=>request.path==='/shift-jis')).toHaveLength(3);
});

test('XHR retains an override across open calls and rejects LOADING/DONE changes', async () => {
  expect(await evaluate(`new Promise((resolve,reject)=>{
    const x=new XMLHttpRequest(), values=[], errors=[];
    x.overrideMimeType('text/plain;charset=Shift_JIS');
    x.onreadystatechange=()=>{if(x.readyState===3||x.readyState===4){try{x.overrideMimeType('text/plain;charset=UTF-8')}catch(e){errors.push(e.name)}}};
    x.onload=()=>{values.push(x.responseText);if(values.length===1){x.open('GET','/shift-jis');x.send()}else resolve({values,errors})};
    x.onerror=reject;x.open('GET','/shift-jis');x.send();
  })`)).toEqual({values:['テスト','テスト'],errors:Array(4).fill('InvalidStateError')});
});

test('XHR blob override controls type without changing bytes and JSON ignores charset', async () => {
  expect(await evaluate(`new Promise((resolve,reject)=>{
    const x=new XMLHttpRequest();x.open('GET','/bytes');x.responseType='blob';x.overrideMimeType('application/custom;test="a b"');
    x.onload=async()=>resolve({type:x.response.type,bytes:[...new Uint8Array(await x.response.arrayBuffer())],isBlob:x.response instanceof Blob,header:x.getResponseHeader('content-type')});
    x.onerror=reject;x.send();
  })`)).toEqual({type:'application/custom;test="a b"',bytes:[255,65],isBlob:true,header:'text/plain;charset=windows-1252'});
  expect(await evaluate(`new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/json');x.responseType='json';x.overrideMimeType('text/plain;charset=Shift_JIS');x.onload=()=>resolve(x.response);x.onerror=reject;x.send()})`)).toBe('テスト');
});

test('XHR blob object URLs preserve final MIME and binary bytes through page fetch', async () => {
  for (const mime of ['text/html','text/plain;charset=GBK']) {
    expect(await evaluate(`new Promise((resolve,reject)=>{
      const x=new XMLHttpRequest();x.open('GET','/bytes');x.responseType='blob';x.overrideMimeType(${JSON.stringify(mime)});
      x.onload=async()=>{const url=URL.createObjectURL(x.response);try{const response=await fetch(url);resolve({type:response.headers.get('content-type'),bytes:[...new Uint8Array(await response.arrayBuffer())]})}catch(error){reject(error)}finally{URL.revokeObjectURL(url)}};
      x.onerror=reject;x.send();
    })`)).toEqual({type:mime,bytes:[255,65]});
  }
});

test('overrideMimeType uses DOMString conversion before checking state', async () => {
  expect(await evaluate(`(()=>{const x=new XMLHttpRequest(), marker={};let missing,symbol,same;try{x.overrideMimeType()}catch(e){missing=e instanceof TypeError}try{x.overrideMimeType(Symbol())}catch(e){symbol=e instanceof TypeError}try{x.overrideMimeType({toString(){throw marker}})}catch(e){same=e===marker}return [missing,symbol,same]})()`)).toEqual([true,true,true]);
});

import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { createDetachedDocument } from '../lib/renderer/document-constructor.js';
import { RendererHost } from '../lib/renderer/host.js';

function dom(callback) {
  const { window, document } = parseHTMLDocument('');
  try { return callback(document, window); }
  finally { window.happyDOM.close(); }
}

test('processing instructions use XML Name, including single letters, Unicode and colons', () => dom(document => {
  const valid = ['A','a','_',':','xml','xml:fail','A·A','a0','a-b.c','中文','é','\u0370','\u200C',
    '\u3001','\uFDCF','\uFFFD','\u{10000}','\u{EFFFF}','a\u0300','a\u203F'];
  for (const target of valid) {
    const pi = document.createProcessingInstruction(target, 'text < & 漢字');
    expect([pi.target, pi.nodeName, pi.nodeType, pi.data]).toEqual([target,target,7,'text < & 漢字']);
    expect(pi.ownerDocument).toBe(document);
    expect(pi.parentNode).toBeNull();
  }
  const invalid = ['', '0', 0, '·A', '×A','A×','\\A','\f','a b','a=b','a\0b','\uD800',
    '\u037E','\u200E','\u2FF0','\uFDD0','\uFFFE','\u{F0000}','\u0300'];
  for (const target of invalid) {
    let error;
    try { document.createProcessingInstruction(target, 'x'); } catch (caught) { error=caught; }
    expect(error instanceof DOMException).toBeTrue();
    expect([error.name,error.code]).toEqual(['InvalidCharacterError',5]);
  }
  expect(() => document.createProcessingInstruction('a','before?>after')).toThrow(DOMException);
  // A simple character-class scan must handle long valid and invalid targets.
  expect(document.createProcessingInstruction('a'.repeat(100_000),'').target.length).toBe(100_000);
  expect(() => document.createProcessingInstruction('a'.repeat(100_000)+' ','')).toThrow(DOMException);
}));

test('processing instruction arguments use ordered DOMString conversion without swallowing exceptions', () => dom(document => {
  const order=[];
  const target={ [Symbol.toPrimitive](hint) { order.push(['target',hint]);return 'A'; } };
  const data={ [Symbol.toPrimitive](hint) { order.push(['data',hint]);return 'x'; } };
  expect(document.createProcessingInstruction(target,data).data).toBe('x');
  expect(order).toEqual([['target','string'],['data','string']]);
  expect(() => document.createProcessingInstruction()).toThrow(TypeError);
  expect(() => document.createProcessingInstruction('a')).toThrow(TypeError);
  expect(() => document.createProcessingInstruction(Symbol(),'')).toThrow(TypeError);
  expect(() => document.createProcessingInstruction('a',Symbol())).toThrow(TypeError);
  expect(document.createProcessingInstruction(null,undefined).data).toBe('undefined');
  const sentinel={};let caught;
  try { document.createProcessingInstruction({toString(){throw sentinel}},''); } catch(error) { caught=error; }
  expect(caught).toBe(sentinel);
}));

test('processing instruction clones retain target, data and their detached owner document', () => dom((document,window) => {
  const detached=createDetachedDocument(window), original=detached.createProcessingInstruction('X:名','one');
  for (const deep of [false,true]) {
    const clone=original.cloneNode(deep);
    expect(clone instanceof window.ProcessingInstruction).toBeTrue();
    expect(clone).not.toBe(original);
    expect(clone.ownerDocument).toBe(detached);
    expect([clone.target,clone.nodeName,clone.data]).toEqual(['X:名','X:名','one']);
    clone.data='two';expect(original.data).toBe('one');
  }
  const pi=document.createProcessingInstruction('A','first');
  const observer=new window.MutationObserver(()=>{});
  observer.observe(pi,{characterData:true,characterDataOldValue:true});
  pi.appendData(' next');pi.nodeValue='last';
  expect(observer.takeRecords().map(r=>[r.type,r.oldValue])).toEqual([['characterData','first'],['characterData','first next']]);
  observer.disconnect();
}));

test('page processing instructions expose normal CharacterData bindings and stable cloned metadata', async () => {
  const renderer=new RendererHost({timeout:20_000});
  try {
    await renderer.start();
    await renderer.call('loadDocument',{url:'https://page.test/',contentType:'text/html',source:'<p>active</p>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(()=>{
      const order=[], d=new Document();
      const p=d.createProcessingInstruction({[Symbol.toPrimitive](hint){order.push(hint);return '中文:A'}},
        {[Symbol.toPrimitive](hint){order.push(hint);return 'hello'}});
      const clone=p.cloneNode(true);d.appendChild(p);
      const mo=new MutationObserver(()=>{});mo.observe(p,{characterData:true,characterDataOldValue:true});
      p.data='second';const records=mo.takeRecords();mo.disconnect();
      let validError=false;try{document.createProcessingInstruction('0','')}catch(e){validError=e instanceof DOMException&&e.name==='InvalidCharacterError'&&e.code===5}
      return [order,p instanceof ProcessingInstruction,p instanceof CharacterData,p instanceof Node,
        p.target,p.nodeName,p.ownerDocument===d,clone.ownerDocument===d,clone.target,clone.data,
        clone.constructor===ProcessingInstruction,records.length,records[0].oldValue,records[0].target===p,
        Object.getOwnPropertySymbols(p).length,validError];
    })()`)).toEqual([['string','string'],true,true,true,'中文:A','中文:A',true,true,'中文:A','hello',true,1,'hello',true,0,true]);
    expect(await renderer.call('evaluate', `(()=>{
      const failures = [
        () => document.createProcessingInstruction(),
        () => document.createProcessingInstruction('a'),
        () => document.createProcessingInstruction(Symbol(), ''),
        () => document.createProcessingInstruction('a', Symbol()),
        () => document.createProcessingInstruction({[Symbol.toPrimitive]:1}, ''),
        () => document.createProcessingInstruction('a', {[Symbol.toPrimitive](){return {}}}),
      ].map(call => {try {call();return false} catch(e) {return e instanceof TypeError && e.constructor===TypeError}});
      const explicit=document.createProcessingInstruction(undefined,undefined), sentinel={}, order=[];
      let targetError=false,dataError=false;
      try {document.createProcessingInstruction({[Symbol.toPrimitive](hint){order.push(['target',hint]);throw sentinel}},
        {toString(){order.push(['unexpected data']);return ''}})} catch(e) {targetError=e===sentinel}
      try {document.createProcessingInstruction({[Symbol.toPrimitive](hint){order.push(['target',hint]);return 'A'}},
        {[Symbol.toPrimitive](hint){order.push(['data',hint]);throw sentinel}})} catch(e) {dataError=e===sentinel}
      return [failures,explicit.target,explicit.data,targetError,dataError,order];
    })()`)).toEqual([[true,true,true,true,true,true],'undefined','undefined',true,true,
      [['target','string'],['target','string'],['data','string']]]);
  } finally { await renderer.close(); }
},30_000);

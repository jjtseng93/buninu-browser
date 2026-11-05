import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

const host = new RendererHost({timeout: 20000, fetch: async () => new Response('')});
beforeAll(async () => {
  await host.call('loadDocument', {url:'https://traversal.test/', contentType:'text/html', source:'<!doctype html><body><div id="root"><b id="one"></b><i id="two"></i></div></body>'});
  await host.call('whenLoaded');
});
afterAll(() => host.close());
const evaluate = source => host.call('evaluate', source);

test('traversal factories preserve IDL conversion order, brands and page-local errors', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for(const kind of ['TreeWalker','NodeIterator']) {
      const create=Document.prototype['create'+kind], Interface=window[kind];
      for(const args of [[],[null],[{}],[document,1n],[document,Symbol()],[document,0,1]]) {
        try{create.apply(document,args);result.push(false)}catch(e){result.push(e instanceof TypeError)}
      }
      let calls=0;const number={valueOf(){calls++;return 1}};
      try{create.call({},document,number)}catch(e){result.push(e instanceof TypeError,calls===0)}
      try{create.call(document,null,number)}catch(e){result.push(e instanceof TypeError,calls===0)}
      try{create.call(document,document,number,1)}catch(e){result.push(e instanceof TypeError,calls===1)}
      const walker=create.call(document,document,4294967297);
      result.push(walker instanceof Interface,Object.getPrototypeOf(walker)===Interface.prototype,
        Object.prototype.toString.call(walker)==='[object '+kind+']',walker.whatToShow===1,
        !Object.getOwnPropertyDescriptor(Interface,'prototype').writable);
      for(const invoke of [()=>new Interface(),()=>Interface.prototype.nextNode.call({}),
          ()=>Object.getOwnPropertyDescriptor(Interface.prototype,'root').get.call({})]) {
        try{invoke();result.push(false)}catch(e){result.push(e instanceof TypeError)}
      }
    }
    return result;
  })()`)).toEqual(Array(40).fill(true));
});

test('filter unsigned-short conversion and exceptions leave the walker usable', async () => {
  expect(await evaluate(`(() => {
    const root=document.getElementById('root'), result=[];
    for(const kind of ['TreeWalker','NodeIterator']) {
      const create=(filter)=>document['create'+kind](root,1,filter);
      for(const verdict of [1,65537,-65535,1.9,'1']) {
        const walker=create(()=>verdict);result.push(walker.nextNode()=== (kind==='TreeWalker'?root.firstChild:root));
      }
      for(const verdict of [1n,Symbol()]) {
        const walker=create(()=>verdict);
        try{walker.nextNode();result.push(false)}catch(e){result.push(e instanceof TypeError)}
      }
      for(const filter of [{}, {acceptNode:1}]) {
        const walker=create(filter);
        try{walker.nextNode();result.push(false)}catch(e){result.push(e instanceof TypeError)}
      }
      let fail=true;const marker={}, walker=create(()=>{if(fail)throw marker;return 1});
      try{walker.nextNode()}catch(e){result.push(e===marker)}
      fail=false;result.push(walker.nextNode()===(kind==='TreeWalker'?root.firstChild:root));
      const badNumber={valueOf(){throw marker}};
      try{create(()=>badNumber).nextNode()}catch(e){result.push(e===marker)}
    }
    return result;
  })()`)).toEqual(Array(24).fill(true));
});

test('recursive TreeWalker filters reject reentry and restore their active flag after exceptions', async () => {
  expect(await evaluate(`(() => {
    const root=document.getElementById('root'), result=[];
    for(const method of ['nextNode','firstChild','lastChild']) {
      let nested=true;
      const walker=document.createTreeWalker(root,1,()=>{if(nested)walker[method]();return 1});
      try{walker[method]();result.push(false,false)}catch(e){result.push(e instanceof DOMException,e.name==='InvalidStateError')}
      result.push(walker.currentNode===root);nested=false;result.push(!!walker[method]());
    }
    const walker=document.createTreeWalker(root);
    for(const value of [null,{},window]) {
      try{walker.currentNode=value;result.push(false)}catch(e){result.push(e instanceof TypeError,walker.currentNode===root)}
    }
    return result;
  })()`)).toEqual(Array(18).fill(true));
});

test('filter access is lazy, keeps object receivers and ignores function acceptNode properties', async () => {
  expect(await evaluate(`(() => {
    const root=document.getElementById('root'), result=[];
    for(const kind of ['TreeWalker','NodeIterator']) {
      let reads=0;const filter={get acceptNode(){reads++;return function(n){result.push(this===filter,n instanceof Node);return 1}}};
      const walker=document['create'+kind](root,1,filter);result.push(reads===0);walker.nextNode();walker.nextNode();result.push(reads===2);
      function fn(n){return 1}Object.defineProperty(fn,'acceptNode',{get(){throw Error('must not read')}});
      result.push(!!document['create'+kind](root,1,fn).nextNode());
    }
    return result;
  })()`)).toEqual(Array(14).fill(true));
});

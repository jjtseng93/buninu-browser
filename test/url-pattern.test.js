import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {urlPatternInterface} from '../lib/renderer/url-pattern.js';

const supported=typeof globalThis.URLPattern==='function';

test.skipIf(!supported)('URLPattern converts IDL inputs before translating native errors',()=>{
  class LocalTypeError extends TypeError {}
  const Pattern=urlPatternInterface(()=>({...globalThis,TypeError:LocalTypeError,Array,Object}));
  const other=urlPatternInterface();
  expect(Pattern).not.toBe(other);
  expect(Pattern.prototype).not.toBe(other.prototype);
  expect(Pattern.length).toBe(0);
  expect(Pattern.prototype.test.length).toBe(0);
  expect(Pattern.prototype.exec.length).toBe(0);
  expect(()=>Pattern()).toThrow(LocalTypeError);
  expect(()=>new Pattern({pathname:'('})).toThrow(LocalTypeError);
  expect(()=>new Pattern(Symbol())).toThrow(LocalTypeError);
  expect(()=>new Pattern({},'https://example.test')).toThrow(LocalTypeError);
  expect(()=>new Pattern({},undefined,{})).toThrow(LocalTypeError);
  expect(()=>new Pattern('https://example.test',undefined,1)).toThrow(LocalTypeError);
  expect(()=>Pattern.prototype.test.call({}, {get pathname(){throw 'must not read'}})).toThrow(LocalTypeError);
  const sentinel={authorError:true};
  for(const input of [{get pathname(){throw sentinel}}, {pathname:{toString(){throw sentinel}}}]) {
    let caught;try{new Pattern(input)}catch(error){caught=error}expect(caught).toBe(sentinel);
  }
  let caught;try{new Pattern('/x',{get ignoreCase(){throw sentinel}})}catch(error){caught=error}
  expect(caught).toBe(sentinel);
  const order=[];
  const fields=['baseURL','hash','hostname','password','pathname','port','protocol','search','username'];
  const source=Object.fromEntries(fields.map(name=>[name,undefined]));
  const proxy=new Proxy(source,{get(target,key){order.push(key);return target[key]}});
  new Pattern(proxy,{get ignoreCase(){order.push('ignoreCase');return false}});
  expect(order).toEqual([...fields,'ignoreCase']);
  const pattern=new Pattern({pathname:{[Symbol.toPrimitive](hint){expect(hint).toBe('string');return '/\ud800/:id'}}});
  expect(pattern.pathname).toBe('/%EF%BF%BD/:id');
  expect(pattern.exec('https://example.test/\ud800/7').pathname.groups.id).toBe('7');
  expect(new Pattern(undefined,undefined).pathname).toBe('*');
  expect(new Pattern(null,null).pathname).toBe('*');
  expect(new Pattern('/books/:id','https://example.test').hostname).toBe('example.test');
  expect(new Pattern({pathname:'/BOOKS/:id'},{ignoreCase:{valueOf(){throw sentinel}}}).test('https://example.test/books/7')).toBeTrue();
  const valid=new Pattern({pathname:'/:id'});
  const match=valid.exec({pathname:'/7'});
  expect(match.inputs).toEqual([{pathname:'/7'}]);
  expect(match.pathname.groups.id).toBe('7');
  expect(Object.getPrototypeOf(match.pathname.groups)).toBe(Object.prototype);
  // The brand is native state, not a spoofable prototype; cross-realm methods
  // accept genuine instances while separately mutable prototypes stay local.
  expect(other.prototype.test.call(valid,'https://example.test/8')).toBeTrue();
  expect(()=>Object.getOwnPropertyDescriptor(Pattern.prototype,'pathname').get.call({})).toThrow(LocalTypeError);
  Pattern.prototype.test=()=>false;
  expect(new other({pathname:'/:id'}).test('https://example.test/8')).toBeTrue();
  const globals={TypeError:LocalTypeError,Array,Object};
  const Captured=urlPatternInterface(()=>globals);
  globals.TypeError=globals.Array=globals.Object=()=>{throw sentinel};
  expect(()=>new Captured({pathname:'('})).toThrow(LocalTypeError);
  expect(new Captured({pathname:'/:id'}).exec('https://example.test/9').pathname.groups.id).toBe('9');
});

test.skipIf(!supported)('pages and workers reuse URLPattern without exposing or mutating host capabilities',async()=>{
  const host=new RendererHost({fetch:async()=>new Response(`onmessage=()=>{
    const pattern=new URLPattern({pathname:'/books/:id'});
    postMessage([pattern.exec('https://example.test/books/42').pathname.groups.id,
      pattern.test('https://example.test/other'),typeof Bun,typeof process,Object.isFrozen(URLPattern.prototype),
      (()=>{try{new URLPattern({pathname:'('})}catch(e){return e.constructor===TypeError}})()]);
  }`,{headers:{'content-type':'text/javascript'}})});
  const run=source=>host.call('evaluate',source);
  const load=async()=>{
    await host.call('loadDocument',{url:'https://pattern.test/',contentType:'text/html',source:'<body>URL routing</body>'});
    await host.call('whenLoaded');
  };
  try {
    await load();
    expect(await run(`(()=>{
      const pattern=new URLPattern({pathname:'/books/:id',search:'q=:query'});
      const result=pattern.exec('https://example.test/books/42?q=hello');
      return [result.pathname.groups.id,result.search.groups.query,pattern.test('https://example.test/other'),
        new URLPattern('/books/:id','https://example.test').hostname,
        new URLPattern({pathname:'/BOOKS/:id'},{ignoreCase:true}).test('https://example.test/books/42'),
        Object.prototype.toString.call(pattern),Object.isFrozen(URLPattern),Object.isFrozen(URLPattern.prototype),typeof Bun,typeof process];
    })()`)).toEqual(['42','hello',false,'example.test',true,'[object URLPattern]',false,false,'undefined','undefined']);
    expect(await run(`(()=>{
      const Originals={Array,Object,TypeError}, pattern=new URLPattern({pathname:'/:id'});
      globalThis.Array=globalThis.Object=globalThis.TypeError=function(){throw 'must not call author constructors'};
      try{
        let failure;try{new URLPattern({pathname:'('})}catch(e){failure=e.constructor===Originals.TypeError}
        const result=pattern.exec('https://example.test/9');
        return [failure,Originals.Object.getPrototypeOf(result)===Originals.Object.prototype,
          Originals.Object.getPrototypeOf(result.inputs)===Originals.Array.prototype,result.pathname.groups.id];
      }finally{Originals.Object.assign(globalThis,Originals)}
    })()`)).toEqual([true,true,true,'9']);
    expect(await run(`(()=>{let caught;const sentinel={sentinel:true};
      try{new URLPattern({get pathname(){throw sentinel}})}catch(e){caught=e}
      let bad;try{new URLPattern({pathname:'('})}catch(e){bad=e.constructor===TypeError}
      const original=URLPattern.prototype.test;try{URLPattern.prototype.test=()=>false}catch{}
      let blocked;try{URLPattern.constructor('return typeof Bun')()}catch(e){blocked=e instanceof TypeError}
      return [caught===sentinel,bad,URLPattern.prototype.test!==original,
        blocked];})()`)).toEqual([true,true,true,true]);
    expect(await run(`new Promise((resolve,reject)=>{
      const worker=new Worker('/pattern-worker.js');
      worker.onmessage=e=>{worker.terminate();resolve(e.data)};
      worker.onerror=reject;worker.postMessage('go');
    })`)).toEqual(['42',false,'undefined','undefined',false,true]);
    expect(await run(`new Promise(resolve=>{
      const frame=document.createElement('iframe');frame.onload=()=>{
        const Pattern=frame.contentWindow.URLPattern;frame.remove();
        resolve(new Pattern({pathname:'/item/:id'}).exec('https://example.test/item/7').pathname.groups.id);
      };document.body.append(frame);
    })`)).toBe('7');
    await load();
    expect(await run(`new URLPattern({pathname:'/books/:id'}).test('https://example.test/books/42')`)).toBeTrue();
  } finally {await host.close();}
},30000);

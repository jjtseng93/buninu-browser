import {test, expect} from 'bun:test';
import {errorEventInterface, exceptionMessage} from '../lib/renderer/error-reporting.js';
import {RendererHost} from '../lib/renderer/host.js';

const errors = {TypeError:class PageTypeError extends TypeError {}};
const ErrorEvent = errorEventInterface(Event, () => errors);

test('ErrorEvent uses ordinary Event dispatch, page error identity and unsigned locations', () => {
  class Derived extends ErrorEvent {}
  const reason={}, event=new Derived('error', {error:reason,message:'test',filename:'page.js',lineno:-1,colno:2**32+3,cancelable:true});
  expect(event).toBeInstanceOf(Derived);expect(event).toBeInstanceOf(Event);
  expect([event.message,event.filename,event.lineno,event.colno,event.error]).toEqual(['test','page.js',4294967295,3,reason]);
  const target=new EventTarget();let received;
  target.addEventListener('error', e=>{received=e;e.preventDefault();});
  expect(target.dispatchEvent(event)).toBeFalse();expect(received).toBe(event);
  const plain=new ErrorEvent('error');
  expect([plain.message,plain.filename,plain.lineno,plain.colno,plain.error]).toEqual(['','',0,0,undefined]);
  expect(Object.prototype.toString.call(event)).toBe('[object ErrorEvent]');
  expect(() => Object.getOwnPropertyDescriptor(ErrorEvent.prototype,'error').get.call({})).toThrow(errors.TypeError);
});

test('ErrorEvent converts dictionaries in Web IDL order and preserves thrown values', () => {
  const seen=[], options={};
  for (const key of ['bubbles','cancelable','composed','colno','error','filename','lineno','message'])
    Object.defineProperty(options,key,{get(){seen.push(key);return undefined;}});
  new ErrorEvent({toString(){seen.push('type');return 'error';}},options);
  expect(seen).toEqual(['type','bubbles','cancelable','composed','colno','error','filename','lineno','message']);
  for (const bad of [Symbol(),1n,{[Symbol.toPrimitive]:1},{valueOf(){return {}},toString(){return {}}}])
    expect(()=>new ErrorEvent('error',{colno:bad})).toThrow(errors.TypeError);
  expect(()=>new ErrorEvent()).toThrow(errors.TypeError);
  expect(()=>ErrorEvent('error')).toThrow(errors.TypeError);
  expect(()=>new ErrorEvent(Symbol())).toThrow(errors.TypeError);
  expect(()=>new ErrorEvent('error',1)).toThrow(errors.TypeError);
  const sentinel={};let caught;
  try {new ErrorEvent('error',{get message(){throw sentinel;}});} catch(e){caught=e;}
  expect(caught).toBe(sentinel);
});

test('exception reporting never evaluates getters, Proxy traps or custom conversions', () => {
  const touched=[];
  const value={get name(){touched.push('name');},get message(){touched.push('message');},toString(){touched.push('toString');}};
  expect(exceptionMessage(value)).toBe('Uncaught [object Object]');
  const proxy=new Proxy(value,{get(){touched.push('get');},getOwnPropertyDescriptor(){touched.push('descriptor');},getPrototypeOf(){touched.push('prototype');}});
  expect(exceptionMessage(proxy)).toBe('Uncaught [object Object]');
  const error=new Error('message');Object.defineProperty(error,'message',{get(){touched.push('Error.message');}});
  expect(exceptionMessage(error)).toBe('Uncaught Error');
  expect(touched).toEqual([]);
  expect(exceptionMessage(null)).toBe('Uncaught null');
  expect(exceptionMessage(Symbol('x'))).toBe('Uncaught Symbol(x)');
});

test('renderer reports uncaught script, listener, timer and microtask errors without stopping later work', async () => {
  const renderer=new RendererHost({timeout:20_000});
  try {
    await renderer.start();
    const load=async source=>{
      await renderer.call('loadDocument',{url:'https://page.test/error-reporting',contentType:'text/html',source});
      await renderer.call('whenLoaded');
    };
    await load(`<script>
      globalThis.events=[];globalThis.handlerCalls=[];globalThis.sentinel={page:'object'};
      addEventListener('error',e=>{events.push({message:e.message,filename:e.filename,error:e.error===sentinel,
        trusted:e.isTrusted,target:e.target===window,current:e.currentTarget===window,brand:e instanceof ErrorEvent,
        bubbles:e.bubbles,cancelable:e.cancelable});e.preventDefault()});
      onerror=function(message,file,line,col,error){handlerCalls.push([arguments.length,this===window,error===sentinel]);};
      globalThis.registered=1;
      </script><script>throw sentinel;registered++;</script><script>
      globalThis.laterScript=true;
      addEventListener('probe',()=>{throw new Error('listener')});
      dispatchEvent(new Event('probe'));globalThis.dispatchReturned=true;
      queueMicrotask(()=>{throw new Error('microtask')});
      setTimeout(()=>{throw new Error('timer')},0);
      </script>`);
    await Bun.sleep(50);
    const result=await renderer.call('evaluate','({events,handlerCalls,registered,laterScript,dispatchReturned})');
    expect(result.events.map(e=>e.message)).toEqual(['Uncaught [object Object]','Uncaught Error: listener','Uncaught Error: microtask','Uncaught Error: timer']);
    expect(result.events.every(e=>e.filename==='https://page.test/error-reporting' && e.trusted && e.target && e.current && e.brand && e.cancelable && !e.bubbles)).toBeTrue();
    expect(result.events[0].error).toBeTrue();
    expect(result.handlerCalls).toEqual([[5,true,true],[5,true,false],[5,true,false],[5,true,false]]);
    expect([result.registered,result.laterScript,result.dispatchReturned]).toEqual([1,true,true]);
    expect(await renderer.call('consoleMessages')).toEqual([]);

    // A script parse error uses the same reporting path and doesn't prevent
    // subsequent scripts from running. No runner or testharness special case.
    await load(`<script>globalThis.failures=[];addEventListener('error',e=>{failures.push(e.error.name);e.preventDefault()})</script>
      <script>for (;) {}</script><script>globalThis.later=true</script>`);
    expect(await renderer.call('evaluate','[failures,later]')).toEqual([['SyntaxError'],true]);

    await load(`<script>
      globalThis.order=[];globalThis.count=0;
      addEventListener('error',()=>{order.push('first')});
      onerror=()=>{order.push('old')};
      addEventListener('error',()=>{order.push('last')});
      onerror=()=>{order.push('new');count++;throw new Error('nested handler')};
      reportError(new Error('original'));
      globalThis.after=true;
      </script>`);
    expect(await renderer.call('evaluate','[order,count,after]')).toEqual([['first','new','last'],1,true]);
    const logs=await renderer.call('consoleMessages');
    expect(logs.length).toBe(2);expect(logs[0].text).toContain('original');expect(logs[1].text).toContain('nested handler');

    await load(`<script>
      globalThis.calls=[];
      onerror=function(){calls.push(arguments.length);return true};
      const special=new ErrorEvent('error',{cancelable:true,error:123});
      globalThis.specialResult=dispatchEvent(special);
      onerror=function(){calls.push(arguments.length);return false};
      const ordinary=new Event('error',{cancelable:true});
      globalThis.ordinaryResult=dispatchEvent(ordinary);
      reportError(new Error('not canceled by false'));
      onerror=()=>true;reportError(new Error('canceled by true'));
      globalThis.missing=false;try{reportError()}catch(e){missing=e.constructor===TypeError}
      globalThis.touched=[];
      onerror=null;reportError({get name(){touched.push('name')},get message(){touched.push('message')},toString(){touched.push('string')}});
      </script>`);
    expect(await renderer.call('evaluate','[calls,specialResult,ordinaryResult,missing,touched]')).toEqual([[5,1,5],false,false,true,[]]);
    const messages=await renderer.call('consoleMessages');
    expect(messages.length).toBe(2);expect(messages[0].text).toContain('not canceled by false');expect(messages[1].text).toContain('[object Object]');
    expect(await renderer.call('evaluate',`(()=>{const e=new ErrorEvent('error');let safe=false;
      try{safe=e.constructor.constructor('return typeof Bun')()==='undefined'}catch{safe=true}
      return [Object.getOwnPropertySymbols(e).length,safe,typeof Bun,typeof process,typeof ErrorEvent.prototype.window]})()`))
      .toEqual([0,true,'undefined','undefined','undefined']);
  } finally {await renderer.close();}
},45_000);

test('resource failures stay on the script element; cross-origin callbacks retain muted errors', async () => {
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request) {
    const path=new URL(request.url).pathname;
    if (path==='/late.js') {await Bun.sleep(40);return new Response("throw new Error('mutated src');");}
    if (path==='/foreign.js') return new Response(`
      setTimeout(()=>{throw new Error('foreign timer')},0);
      queueMicrotask(()=>{throw new Error('foreign microtask')});
      addEventListener('foreign',()=>{throw new Error('foreign listener')});
      document.body.onclick=()=>{throw new Error('foreign handler')};
      requestAnimationFrame(()=>{throw new Error('foreign animation')});
      throw new Error('foreign synchronous');
    `,{headers:{'content-type':'text/javascript'}});
    return new Response('missing',{status:404});
  }});
  const renderer=new RendererHost({timeout:20_000});
  try {
    await renderer.start();
    await renderer.call('loadDocument',{url:`http://127.0.0.1:${server.port}/page`,contentType:'text/html',source:`<body><script>
      globalThis.events=[];globalThis.resources=[];globalThis.resourceTrust=[];
      addEventListener('error',e=>{if(e.target===window){events.push([e.message,e.filename,e.lineno,e.colno,e.error]);e.preventDefault()}});
      </script><script src="/missing.js" onerror="resources.push('missing');resourceTrust.push(event.isTrusted)"></script>
      <script src="http://localhost:${server.port}/foreign.js"></script><script>
      dispatchEvent(new Event('foreign'));document.body.dispatchEvent(new Event('click'));
      globalThis.later=true;
      const s=document.createElement('script');s.src='/also-missing.js';s.onerror=e=>{resources.push('dynamic');resourceTrust.push(e.isTrusted)};document.body.appendChild(s);
      const late=document.createElement('script');late.src='http://localhost:${server.port}/late.js';document.body.appendChild(late);late.src='/disguised.js';
      </script>`});
    await renderer.call('whenLoaded');await Bun.sleep(80);
    const result=await renderer.call('evaluate','({events,resources,resourceTrust,later})');
    expect(result.resources).toEqual(['missing','dynamic']);expect(result.later).toBeTrue();
    expect(result.resourceTrust).toEqual([true,true]);
    expect(result.events.length).toBe(7);
    for (const event of result.events) expect(event).toEqual(['Script error.','',0,0,null]);
  } finally {await renderer.close();server.stop(true);}
},30_000);

test('handler replacement refreshes error-source muting while preserving listener order', async () => {
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch() {
    return new Response(`
      becomesForeign.onclick=()=>{order.push('foreign-handler');throw new Error('foreign replacement')};
      becomesLocal.onclick=()=>{throw new Error('old foreign handler')};
    `,{headers:{'content-type':'text/javascript'}});
  }});
  const renderer=new RendererHost({timeout:20_000});
  const url=`http://127.0.0.1:${server.port}/page`;
  try {
    await renderer.start();
    await renderer.call('loadDocument',{url,contentType:'text/html',source:`<body><script>
      globalThis.events=[];globalThis.order=[];
      addEventListener('error',e=>{events.push([e.message,e.filename,e.error?.message??null]);e.preventDefault()});
      globalThis.becomesForeign=document.createElement('button');
      globalThis.becomesLocal=document.createElement('button');
      becomesForeign.addEventListener('click',()=>order.push('foreign-before'));
      becomesForeign.onclick=()=>order.push('old local handler');
      becomesForeign.addEventListener('click',()=>order.push('foreign-after'));
      becomesLocal.addEventListener('click',()=>order.push('local-before'));
      </script><script src="http://localhost:${server.port}/foreign.js"></script><script>
      becomesLocal.addEventListener('click',()=>order.push('local-after'));
      becomesLocal.onclick=()=>{order.push('local-handler');throw new Error('local replacement')};
      becomesForeign.dispatchEvent(new Event('click'));
      becomesLocal.dispatchEvent(new Event('click'));
      </script>`});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate','({events,order})')).toEqual({
      events:[['Script error.','',null],['Uncaught Error: local replacement',url,'local replacement']],
      order:['foreign-before','foreign-handler','foreign-after','local-before','local-handler','local-after'],
    });
  } finally {await renderer.close();server.stop(true);}
},30_000);

test('module parse/runtime failures report once, load failures stay resource errors and import rejects', async () => {
  const scripts={
    '/syntax.js':'export const broken = ;',
    '/runtime.js':"throw new Error('module runtime');",
    '/dependency.js':"import './runtime.js'; globalThis.unreachableModule=true;",
    '/dynamic.js':"throw new Error('caught import');",
  };
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(request) {
    const path=new URL(request.url).pathname;
    return new Response(scripts[path]??'missing',{status:path in scripts?200:404,headers:{'content-type':'text/javascript'}});
  }});
  const renderer=new RendererHost({timeout:20_000});
  try {
    await renderer.start();
    await renderer.call('loadDocument',{url:`http://127.0.0.1:${server.port}/page`,contentType:'text/html',source:`<script>
      globalThis.errors=[];globalThis.resources=[];
      addEventListener('error',e=>{if(e.target===window){errors.push(e.error.name+':'+e.error.message);e.preventDefault()}});
      </script><script type="module" src="/syntax.js" onload="resources.push('syntax loaded')" onerror="resources.push('wrong syntax error')"></script>
      <script type="module" src="/dependency.js" onload="resources.push('dependency loaded')" onerror="resources.push('wrong runtime error')"></script>
      <script type="module" src="/missing.js" onerror="resources.push('missing')"></script>
      <script type="module">import('/dynamic.js').catch(e=>globalThis.caught=e.message);</script>
      <script>globalThis.later=true;</script>`});
    await renderer.call('whenLoaded');await Bun.sleep(50);
    const result=await renderer.call('evaluate','({errors,resources,caught,later,unreachable:typeof unreachableModule})');
    expect(result.errors.length).toBe(2);expect(result.errors[0]).toContain('SyntaxError:');expect(result.errors[1]).toBe('Error:module runtime');
    expect(result.resources).toEqual(['syntax loaded','dependency loaded','missing']);
    expect([result.caught,result.later,result.unreachable]).toEqual(['caught import',true,'undefined']);
  } finally {await renderer.close();server.stop(true);}
},30_000);

test('SES error defaults retain standard data descriptors and native exception names without reading page getters', async () => {
  const renderer=new RendererHost({timeout:20000});
  try {
    await renderer.call('loadDocument',{url:'https://page.test/errors',contentType:'text/html',source:'<!doctype html><body></body>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate',`(()=>{
      const result=[];
      for(const name of ['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']) {
        const C=globalThis[name],n=Object.getOwnPropertyDescriptor(C.prototype,'name'),m=Object.getOwnPropertyDescriptor(C.prototype,'message');
        result.push([C.name,n.value,n.writable,n.enumerable,n.configurable,m.value,m.writable,typeof n.get]);
      }
      return result;
    })()`)).toEqual(['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']
      .map(name=>[name,name,true,false,true,'',true,'undefined']));
    const result=await renderer.call('evaluate',`(()=>{
      const reported=[];globalThis.accesses=0;
      addEventListener('error',e=>{reported.push([e.message,e.error.name]);e.preventDefault()});
      for(const action of [()=>null.field,()=>JSON.parse('{'),()=>new Array(-1)]) {
        try{action()}catch(error){reportError(error);console.error(error)}
      }
      const error=new TypeError('secret');
      const getter=()=>{accesses++;throw Error('getter ran')};getter.originalValue='ForgedError';
      Object.defineProperty(error,'name',{get:getter});
      console.error(error);
      return [reported.map(row=>row[0].startsWith('Uncaught '+row[1]+':')),accesses,typeof getStackString];
    })()`);
    expect(result).toEqual([[true,true,true],0,'undefined']);
    const messages=await renderer.call('consoleMessages');
    expect(messages.slice(0,3).map(e=>e.text.split(':')[0])).toEqual(['TypeError','SyntaxError','RangeError']);
    expect(messages[3].text).not.toContain('ForgedError');
    expect(await renderer.call('evaluate','accesses')).toBe(0);
    expect(await renderer.call('evaluate',`(()=>{
      const touched=[];
      for(const key of ['name','message','stack']) {
        const error=new Error('accessor');
        Object.defineProperty(error,key,{get(){touched.push(key);return 'author'}});
        console.error(error);
      }
      for(const key of ['name','message']) {
        const error=new Error('conversion');
        error[key]={toString(){touched.push(key+'.toString');return 'author'}};
        console.error(error);
      }
      const error=new Error('proxy');
      Object.setPrototypeOf(error,new Proxy(Error.prototype,{
        get(){touched.push('get')},
        getOwnPropertyDescriptor(){touched.push('descriptor')},
        getPrototypeOf(){touched.push('prototype')}
      }));
      console.error(error);
      return touched;
    })()`)).toEqual([]);
    await renderer.call('evaluate',"TypeError.prototype.name='LocalError'");
    expect(await renderer.call('evaluate',"new TypeError().name")).toBe('LocalError');
    await renderer.call('loadDocument',{url:'https://page.test/new',contentType:'text/html',source:'<!doctype html><body></body>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate',"new TypeError().name")).toBe('TypeError');
  } finally {await renderer.close();}
},30000);

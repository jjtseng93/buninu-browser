import {test,expect,beforeAll,afterAll} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';

let renderer;
const requests=[];
beforeAll(async()=>{
 renderer=new RendererHost({timeout:20000,network:new NetworkService({fetch:async(url,init)=>{
  requests.push({url,method:init.method,headers:Object.fromEntries(init.headers)});
  return new Response('ok',{headers:{'content-type':'text/plain','x-result':'yes'}});
 }})});
 await renderer.start();
 await renderer.call('loadDocument',{url:'https://contract.test/',source:'<!doctype html><p>XHR</p>',contentType:'text/html'});
});
afterAll(()=>renderer?.close());
const evaluate=code=>renderer.call('evaluate',code);

test('XHR converts arguments in IDL order and validates before replacing a live request',async()=>{
 const result=await evaluate(`(()=>{const x=new XMLHttpRequest(),log=[],errors=[];
 const str=(name,value)=>({toString(){log.push(name);return value}});
 x.open(str('method','get'),str('url','/one'),{valueOf(){throw 'unexpected'}},str('username','name'),str('password','secret'));
 for(const method of ['', 'GET\\n', 'G T', 'poſt', 'trace', 'CONNECT'])try{x.open(method,'/bad')}catch(e){errors.push([e.name,e instanceof DOMException,x.readyState])}
 let count=0;x.onreadystatechange=()=>count++;x.open('GET','/two');x.open('GET','/three');
 return [log,errors,count]})()`);
 expect(result).toEqual([['method','url','username','password'],[
  ...Array.from({length:3},()=>['SyntaxError',true,1]),['TypeError',false,1],['SecurityError',true,1],['SecurityError',true,1]],0]);
 expect(await evaluate(`(()=>{const x=new XMLHttpRequest(),log=[],err={};let caught;
 try{x.open('GET',{toString(){throw err}})}catch(e){caught=e===err}
 try{x.open('TRACE','http://[',true,{toString(){log.push('user');return 'u'}},{toString(){log.push('pass');return 'p'}})}catch(e){log.push(e.name)}
 return [caught,log,x.readyState]})()`)).toEqual([true,['user','pass','SecurityError'],0]);
});

test('ByteString and missing argument errors belong to the captured page realm',async()=>{
 expect(await evaluate(`(()=>{const x=new XMLHttpRequest(),Original=TypeError,out=[];
 const probes=[()=>x.open(),()=>x.open('GET'),()=>x.open(Symbol(),'x'),()=>x.open('GET牛','x'),
 ()=>x.setRequestHeader(),()=>x.setRequestHeader('x'),()=>x.setRequestHeader('牛','x'),
 ()=>x.setRequestHeader('x','牛'),()=>x.getResponseHeader(),()=>x.getResponseHeader(Symbol()),()=>x.getResponseHeader('牛')];
 const saved=globalThis.TypeError;globalThis.TypeError=function Replaced(){};
 try{for(const probe of probes)try{probe();out.push(false)}catch(e){out.push(e instanceof Original)}}finally{globalThis.TypeError=saved}
 return out})()`)).toEqual(Array(11).fill(true));
});

test('header conversions may reopen/send and state checks use the resulting request',async()=>{
 expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/old');
 x.setRequestHeader('x-old','discard');x.setRequestHeader({toString(){x.open('GET','/reopened');return 'x-new'}},'kept');
 let error,order=[];x.onloadend=()=>resolve([error,order]);
 try{x.setRequestHeader({toString(){order.push('name');return 'x-late'}},{toString(){order.push('value');x.send();return 'ignored'}})}catch(e){error=e.name}
 })`)).toEqual(['InvalidStateError',['name','value']]);
 const request=requests.find(r=>new URL(r.url).pathname==='/reopened');
 expect(request.headers['x-new']).toBe('kept');
 expect(request.headers['x-old']).toBeUndefined();
 expect(request.headers['x-late']).toBeUndefined();
 expect(requests.some(r=>new URL(r.url).pathname==='/old')).toBeFalse();
});

test('header normalization, errors, forbidden names and response lookup follow XHR rules',async()=>{
 const result=await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),errors=[];x.open('GET','/headers');
 for(const [n,v] of [['bad name','ok'],['x','a\\nb'],['x','a\\0b']])try{x.setRequestHeader(n,v)}catch(e){errors.push([e.name,e instanceof DOMException])}
 for(const [n,v] of [['Host','evil.test'],['Sec-Test','x'],['Proxy-Test','x'],['X-HTTP-Method','GET, TRACE'],['X-Method-Override','connect']])x.setRequestHeader(n,v);
 x.setRequestHeader('X-Custom','\\r\\n value \\t');x.setRequestHeader('x-custom','next');
 x.setRequestHeader('X-HTTP-Method-Override','"foo, TRACE"');x.setRequestHeader('X-Empty','');
 x.onloadend=()=>resolve([errors,x.getResponseHeader('X-Result'),['x-result ',' x-result','x-result\\n','x-result:','x¾'].map(n=>x.getResponseHeader(n))]);x.send()})`);
 expect(result).toEqual([[['SyntaxError',true],['SyntaxError',true],['SyntaxError',true]],'yes',Array(5).fill(null)]);
 const headers=requests.find(r=>new URL(r.url).pathname==='/headers').headers;
 expect(headers['x-custom']).toBe('value, next');expect(headers['x-empty']).toBe('');
 expect(headers['x-http-method-override']).toBe('"foo, TRACE"');
 for(const name of ['host','sec-test','proxy-test','x-http-method','x-method-override'])expect(headers[name]).toBeUndefined();
});

test('XHR and fetch preserve custom method case through the controller',async()=>{
 for(const [method,expected] of [['get','GET'],['pOsT','POST'],['patch','patch'],['MiXeD','MiXeD']]){
  await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();x.open(${JSON.stringify(method)},'/method');x.onloadend=resolve;x.send()})`);
  expect(requests.at(-1).method).toBe(expected);
  await evaluate(`fetch('/fetch-method',{method:${JSON.stringify(method)}}).then(r=>r.text())`);
  expect(requests.at(-1).method).toBe(expected);
 }
});

test('controller repeats method/header guards and CORS allows custom methods case-sensitively',async()=>{
 const seen=[];
 const network=new NetworkService({fetch:async(url,init)=>{
  seen.push({method:init.method,headers:Object.fromEntries(init.headers)});
  return new Response(null,{status:204,headers:{'access-control-allow-origin':'https://source.test',
   'access-control-allow-methods':'MiXeD', 'access-control-allow-headers':'x-ok'}});
 }});
 await network.pageFetch({url:'https://other.test/',method:'MiXeD',headers:[['X-Method-Override','GET, TRACK'],['x-ok','yes']]},'https://source.test/');
 expect(seen.map(r=>r.method)).toEqual(['OPTIONS','MiXeD']);
 expect(seen[1].headers['x-method-override']).toBeUndefined();
 await expect(network.pageFetch({url:'https://other.test/',method:'mixed'},'https://source.test/')).rejects.toThrow();
 for(const method of ['GET\n','poſt','trace'])await expect(network.pageFetch({url:'https://source.test/',method},'https://source.test/')).rejects.toThrow();
});

test('native transport rejects rewritten methods before any CORS preflight or request',async()=>{
 const seen=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  seen.push(request.method);
  return new Response(null,{status:204,headers:{'access-control-allow-origin':'http://source.test',
   'access-control-allow-methods':request.headers.get('access-control-request-method')??request.method}});
 }});
 try{
  const network=new NetworkService();
  for(const method of ['PATCH','patch','MiXeD']){
   seen.length=0;
   const transmitted=new Request(server.url,{method}).method;
   const pending=network.pageFetch({url:server.url.href,method},'http://source.test/');
   if(transmitted!==method){
    await expect(pending).rejects.toThrow('Native HTTP transport cannot preserve method');
    expect(seen).toEqual([]);
   }else{
    expect((await pending).status).toBe(204);
    expect(seen).toEqual(['OPTIONS',method]);
   }
  }
 }finally{server.stop(true)}
});

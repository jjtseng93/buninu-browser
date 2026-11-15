import {test,expect} from 'bun:test';
import {createWebView} from '../lib/qml/webview-host.js';

const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await Bun.sleep(20);}throw Error('WebView timed out');};

test('HTTP WebView navigates, forwards input, reloads/history, scales and disposes',async()=>{
 const events=[],frames=[],requests=[];
 const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(req){
  const u=new URL(req.url);requests.push(u.pathname);
  if(u.pathname==='/event')return new Response('ok');
  return new Response(`<style>body{margin:0;background:red}a{display:block;width:100px;height:50px}</style><a href="/two">next</a><script>
  document.addEventListener('keydown',e=>fetch('/event?key='+e.key));
  </script>`,{headers:{'Content-Type':'text/html'}});
 }});
 const view=createWebView({onFrame:f=>frames.push(f),onState:s=>events.push(s),clipboard:{read:async()=>'',write:async()=>{}}});
 const origin=`http://127.0.0.1:${server.port}`;
 try{
  view.resize(160,100,2);view.navigate(origin+'/one');
  await until(()=>events.some(e=>e.loaded&&e.url===origin+'/one'));
  await until(()=>frames.some(f=>f.width===320&&f.height===200));
  view.input('key',{key:'x',eventType:'keydown',text:'x'});
  await until(()=>requests.includes('/event'));
  view.input('button',{x:20,y:20,button:'left',phase:'down'});
  view.input('button',{x:20,y:20,button:'left',phase:'up'});
  await until(()=>events.some(e=>e.url===origin+'/two'));
  events.length=0;view.reload();
  await until(()=>events.some(e=>e.loaded));expect(events.some(e=>e.loading)).toBe(true);
  events.length=0;view.back();await until(()=>events.some(e=>e.loaded&&e.url===origin+'/one'));
  events.length=0;view.forward();await until(()=>events.some(e=>e.loaded&&e.url===origin+'/two'));
  expect(frames[0].pixels.byteLength).toBe(frames[0].width*frames[0].height*4);
 }finally{await view.dispose();server.stop(true);}
},30000);

test('HTTP WebView can dispose during initial renderer startup',async()=>{
 const states=[];
 const view=createWebView({onFrame:()=>{},onState:s=>states.push(s),clipboard:{read:async()=>'',write:async()=>{}}});
 view.navigate('http://127.0.0.1:1/');
 await view.dispose();
 expect(states).toEqual([]);
 await view.dispose();
},10000);

test('WebView closes while a remote navigation never returns',async()=>{
 let requested=false;
 const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(){requested=true;return new Promise(()=>{});}});
 const view=createWebView({onFrame:()=>{},onState:()=>{},clipboard:{read:async()=>'',write:async()=>{}}});
 try{
  view.navigate(`http://127.0.0.1:${server.port}/`);await until(()=>requested);
  await view.dispose();
 }finally{server.stop(true);await view.dispose();}
},10000);

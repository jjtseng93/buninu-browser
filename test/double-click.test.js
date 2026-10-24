import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {CdpServer} from '../lib/cdp-server.js';
import {CDP} from '../tools/browser-lab.js';
import {attachInput} from '../frontends/wayland/input.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const html=`<body style="margin:0"><div id="box" style="width:200px;height:100px">Double click</div><script>globalThis.events=[];for(const type of ['mousedown','mouseup','click','dblclick'])document.getElementById('box').addEventListener(type,e=>{globalThis.events.push(type+':'+e.detail);e.preventDefault()})</script>`;
function pointer(context){
 let seat,ptr;const errors=[];
 const client={globals:new Map([['wl_seat',1]]),connection:{closed:false},bind:(n,v,cb)=>{seat=cb;return 1},object:(n,cb)=>{ptr=cb;return 2},request(){}};
 attachInput(client,{surface:3,closed:false},context,e=>errors.push(e));seat('capabilities',[1]);ptr('enter',[1,3,20,20]);
 return {event:ptr,errors,tap(time,x=20,y=20){ptr('motion',[time,x,y]);ptr('button',[1,time,272,1]);ptr('button',[2,time+30,272,0]);}};
}
const until=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await Bun.sleep(20)}throw Error('input did not settle')};

test('CDP clickCount reaches DOM clicks and dblclick after cancelled click',async()=>{
 const b=await createBrowser({spareRenderer:false});const server=CdpServer.create(b.context).listen(0);
 const cdp=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
 try{
  await cdp.ready;
  const {targetId}=await cdp.send('Target.createTarget',{url:'data:text/html,'+encodeURIComponent(html)});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
  await b.context.navigate('data:text/html,'+encodeURIComponent(html));
  for(const clickCount of [1,2,3])for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:20,y:20,button:'left',clickCount});
  expect(await b.context.evaluate('events')).toEqual(['mousedown:1','mouseup:1','click:1','mousedown:2','mouseup:2','click:2','dblclick:2','mousedown:3','mouseup:3','click:3']);
 }finally{cdp.close();server.stop(true);b.close()}
},30000);

test('Wayland clicks reach HTML and QML double-tap handlers',async()=>{
 const b=await createBrowser({spareRenderer:false});const dir=mkdtempSync('/tmp/double-click-');
 try{
  await b.context.navigate('data:text/html,'+encodeURIComponent(html));
  const p=pointer(b.context);p.tap(1000);p.tap(1180,28,24);
  await until(async()=>(await b.context.evaluate('events.length'))===7);
  expect(await b.context.evaluate('events.at(-1)')).toBe('dblclick:2');expect(p.errors).toEqual([]);
  await Bun.write(join(dir,'main.qml'),`import QtQuick
Rectangle {width:200;height:100;color:"white";property int doubles:0
 Text {id:status;text:"doubles="+parent.doubles}
 TapHandler {onDoubleTapped:parent.doubles++}
}`);
  await b.context.navigate(Bun.pathToFileURL(join(dir,'main.qml')).href);
  const q=pointer(b.context);q.tap(2000,60,60);q.tap(2180,65,63);
  await until(async()=>(await b.context.evaluate('document.getElementById("status").textContent'))==='doubles=1');
  expect(q.errors).toEqual([]);
 }finally{b.close();rmSync(dir,{recursive:true,force:true})}
},30000);

test('Wayland count resets on timeout, distance and leave and handles timestamp wrap',async()=>{
 const counts=[];const p=pointer({click:(x,y,o)=>counts.push(o.clickCount),move(){}});
 p.tap(0xffffff00);p.tap(0x20);p.tap(1000);p.tap(1100,100,100);
 p.event('leave',[]);p.event('enter',[1,3,100,100]);p.tap(1150,100,100);
 await Bun.sleep(0);expect(counts).toEqual([1,2,1,1,1]);
});

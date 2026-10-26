import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {createBrowser} from '../lib/headless-shell.js';
import {CdpServer} from '../lib/cdp-server.js';
import {CDP,launch} from '../tools/browser-lab.js';
import {WaylandUrlBar} from '../frontends/wayland/urlbar.js';

const source=`<style>body{margin:0}#box{width:300px;height:160px}#a,#b{display:inline-block;width:100px;height:100px}canvas{display:block}</style>
<div id="box"><span id="a">A</span><span id="b">B</span></div><input id="field" value="hello"><canvas id="paint" width="300" height="100"></canvas>
<script>
globalThis.paint=document.getElementById("paint");globalThis.a=document.getElementById("a");globalThis.field=document.getElementById("field");
globalThis.events=[];globalThis.cancelDown=false;globalThis.cancelPointer=false;
for(const type of ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup','click','auxclick'])document.addEventListener(type,e=>{events.push([type,e.target.id,e.button,e.buttons,e.shiftKey]);if(type==='mousedown'&&cancelDown)e.preventDefault();if(type==='pointerdown'&&cancelPointer)e.preventDefault()});
let drawing=false;const ctx=paint.getContext('2d');paint.onmousedown=()=>drawing=true;document.addEventListener('mouseup',()=>drawing=false);paint.onmousemove=e=>{if(drawing&&(e.buttons&1)){ctx.fillStyle='red';ctx.fillRect(0,0,20,20)}};
</script>`;
async function check(c){
 await c.send('Page.navigate',{url:'data:text/html,'+encodeURIComponent(source)});
 for(let i=0;i<200;i++){if(await c.evaluate('!!document.getElementById("paint")'))break;await Bun.sleep(20)}
 const send=(type,x=20,y=20,extra={})=>c.send('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...extra});
 await send('mouseMoved',20,20,{buttons:0,button:'none'});await c.evaluate('events=[]');
 await send('mousePressed',20,20,{modifiers:8});
 expect(await c.evaluate('events')).toEqual([['pointerdown','a',0,1,true],['mousedown','a',0,1,true]]);
 await send('mouseMoved',40,40,{modifiers:8});
 expect((await c.evaluate('events')).slice(-2)).toEqual([['pointermove','a',-1,1,true],['mousemove','a',0,1,true]]);
 await send('mouseReleased',40,40,{modifiers:8});
 expect((await c.evaluate('events')).slice(-3)).toEqual([['pointerup','a',0,0,true],['mouseup','a',0,0,true],['click','a',0,0,true]]);
 // Sibling press/release activates the common ancestor, never the release sibling.
 await c.evaluate('events=[]');await send('mousePressed');await send('mouseReleased',140,20);
 expect((await c.evaluate('events')).at(-1)).toEqual(['click','box',0,0,false]);
 // A disconnected press target cannot activate another element on release.
 await send('mousePressed');await c.evaluate('a.remove();events=[]');await send('mouseReleased');
 expect((await c.evaluate('events')).some(e=>e[0]==='click')).toBe(false);
 // Canceled mousedown must not focus the editor; normal focus happens on press.
 const rect=await c.evaluate('field.getBoundingClientRect().toJSON()');
 await c.evaluate('cancelDown=true');await send('mousePressed',rect.x+10,rect.y+8);
 expect(await c.evaluate('document.activeElement.id')).not.toBe('field');await send('mouseReleased',rect.x+10,rect.y+8);
 await c.evaluate('cancelDown=false');await send('mousePressed',rect.x+10,rect.y+8);
 expect(await c.evaluate('document.activeElement.id')).toBe('field');await send('mouseReleased',rect.x+10,rect.y+8);
 // pointerdown cancellation suppresses compatibility mouse events, not click.
 await c.evaluate('cancelPointer=true;events=[]');await send('mousePressed',20,20);await send('mouseMoved',30,30);await send('mouseReleased',30,30);
 expect((await c.evaluate('events')).map(e=>e[0])).toEqual(['pointerdown','pointermove','pointerup','click']);
 await c.evaluate('cancelPointer=false;events=[]');
 // The same canvas drawing contract as the manual test, checked before release.
 const paint=await c.evaluate('paint.getBoundingClientRect().toJSON()');
 await send('mousePressed',paint.x+20,paint.y+20);await send('mouseMoved',paint.x+40,paint.y+40);
 expect(await c.evaluate('Array.from(paint.getContext("2d").getImageData(5,5,1,1).data)')).toEqual([255,0,0,255]);
 await send('mouseReleased',paint.x+40,paint.y+40);await send('mouseMoved',20,20,{buttons:0,button:'none'});
 expect((await c.evaluate('events')).at(-1)[3]).toBe(0);
}
test('CDP real pointer phases preserve dragging, focus and click targets',async()=>{
 const b=await createBrowser({spareRenderer:false}),server=CdpServer.create(b.context).listen(0),c=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
 try{await check(c)}finally{c.close();server.stop(true);b.close()}
},30000);
test.skipIf(process.env.BUNINU_TEST_CHROMIUM!=='1')('Chromium reference uses the same pointer event contract',async()=>{
 const dir=mkdtempSync('/tmp/pointer-chromium-');let app;
 try{app=await launch('chromium',dir);await check(app.cdp)}finally{await app?.stop();rmSync(dir,{recursive:true,force:true})}
},30000);
test('Wayland toolbar sends real press and motion before release, including over chrome',async()=>{
 const b=await createBrowser({spareRenderer:false});const bar=new WaylandUrlBar(b.context,{history:{list:()=>[],add(){}}});
 try{
  await b.context.navigate('data:text/html,'+encodeURIComponent(source));
  await bar.pointerButton(20,bar.height+20,272,1,{clickCount:1});
  expect((await b.context.evaluate('events')).map(e=>e[0])).toEqual(['pointerdown','mousedown']);
  await bar.move(40,bar.height+40);
  expect((await b.context.evaluate('events')).at(-1)[3]).toBe(1);
  await bar.pointerButton(40,0,272,0,{clickCount:1});
  await bar.move(40,bar.height+40);
  expect((await b.context.evaluate('events')).at(-1)[3]).toBe(0);
  expect(bar.editor.editing).toBe(false);
 }finally{bar.dispose();b.close()}
},30000);

test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('real Wayland pointer draws on the unchanged manual test page',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const {launch:wayland}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync('/tmp/pointer-wayland-'),saved=process.env.XDG_RUNTIME_DIR;
 process.env.XDG_RUNTIME_DIR=dir;let land,app;
 const until=async fn=>{for(let n=0;n<200;n++){if(await fn())return;await Bun.sleep(20)}throw Error('Wayland pointer timed out')};
 try{
  land=await start(['--remote-debugging-port=0','--window-size=800,700']);
  app=await wayland({socket:dir+'/wayland-buninu',url:Bun.pathToFileURL(new URL('./manual-pointer-scroll.html',import.meta.url).pathname).href});
  const c=app.browser.context;
  await until(()=>land.compositor.wm.renderSurfaces().some(s=>s.pixels));
  const top=await c.evaluate('document.getElementById("paint").getBoundingClientRect().top');
  await c.scroll(0,top-100);
  const rect=await c.evaluate('document.getElementById("paint").getBoundingClientRect().toJSON()');
  const surface=land.compositor.wm.renderSurfaces().find(s=>s.pixels),origin=land.compositor.wm.origin(surface);
  const x=origin.x+rect.x+40,y=origin.y+app.toolbar.height+rect.y+40;
  land.context.dispatchMouseEvent({type:'mouseMoved',x,y});
  land.context.dispatchMouseEvent({type:'mousePressed',x,y,button:'left',buttons:1});
  await until(async()=>(await c.evaluate('document.getElementById("drag").textContent'))==='按住左鍵');
  land.context.dispatchMouseEvent({type:'mouseMoved',x:x+80,y:y+40,button:'left',buttons:1});
  await until(async()=>await c.evaluate('(()=>{const c=document.getElementById("paint");return c.getContext("2d").getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)})()'));
  land.context.dispatchMouseEvent({type:'mouseReleased',x:x+80,y:y+40,button:'left',buttons:0});
  await until(async()=>(await c.evaluate('document.getElementById("drag").textContent'))==='左鍵已放開');
  expect(await c.evaluate('document.getElementById("log").textContent')).toContain('mousedown');
 }finally{app?.close();land?.close();if(saved===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=saved;rmSync(dir,{recursive:true,force:true})}
},30000);

test('pointer bursts preserve drawing points while batching raster work',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/pointer-paint-batching.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
 expect(stderr).toBe('');expect(exit).toBe(0);
},15000);

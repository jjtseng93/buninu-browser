import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {launch} from '../frontends/wayland/index.js';
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('HTML Ctrl-C/V, navigator and toolbar share Land clipboard even with host denied',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const dir=mkdtempSync('/tmp/html-clipboard-'),old=process.env.XDG_RUNTIME_DIR;
 let land,app;const copied='Wayland 中文',writes=[];
 const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await Bun.sleep(20);}throw Error('Clipboard did not settle');};
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(`<input id="field" value="Wayland 中文"><button id="read" style="position:absolute;top:50px;left:0;width:100px;height:30px" onclick="navigator.clipboard.readText().then(t=>globalThis.readResult=t)">Read</button>`,{headers:{'content-type':'text/html; charset=utf-8'}})});
 const url=`http://127.0.0.1:${server.port}/`;
 const run=s=>app.browser.context.evaluate(s);
 const key=async(key,modifiers=2)=>{
  for(const type of ['keyDown','keyUp'])land.context.dispatchKeyEvent({type,key,code:'Key'+key.toUpperCase(),modifiers});
  await Bun.sleep(100);
 };
 try{
  process.env.XDG_RUNTIME_DIR=dir;
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  land.compositor.clipboard.host={write:async text=>{writes.push(text);throw Error('Android background denied');},read:async()=>{throw Error('Android background denied');},close(){}};
  app=await launch({url,socket:dir+'/wayland-buninu'});
  await wait(()=>app.client.clipboard.serial>0);
  await run('document.getElementById("field").focus();document.getElementById("field").select()');
  await key('c');await wait(()=>writes.length>0);expect(writes.at(-1)).toBe(copied);
  await key('ArrowRight',0);await key('v');
  await wait(async()=>await run('document.getElementById("field").value')===copied+copied);
  app.close();await app.done;
  await wait(()=>land.compositor.clipboard.selection?.cachedText);
  app=await launch({url,socket:dir+'/wayland-buninu'});
  await wait(()=>app.client.clipboard.selection>0);
  await run('document.getElementById("field").focus();document.getElementById("field").select()');
  await key('Backspace',0);await key('v');
  await wait(async()=>await run('document.getElementById("field").value')===copied);
  await app.browser.context.click(20,65);
  await wait(async()=>await run('globalThis.readResult')===copied);
  // URL bar uses the same selection and the same denied-host fallback.
  app.toolbar.open(true);await key('v');await wait(()=>app.toolbar.editor.text===copied);
  expect(land.compositor.clipboard.textCache.bytes.toString()).toBe(copied);
  // Copy a partial URL-bar selection through the compositor, then insert it.
  await key('ArrowRight',0);await key('ArrowLeft',8);await key('c');
  await wait(()=>writes.at(-1)==='文');
  await key('ArrowRight',0);await key('v');
  await wait(()=>app.toolbar.editor.text===copied+'文');
  // Pasting over a selection replaces it rather than appending twice.
  await key('ArrowLeft',8);await key('v');
  await wait(()=>app.toolbar.editor.text===copied+'文');
 }finally{app?.close();land?.close();server.stop(true);if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;rmSync(dir,{recursive:true,force:true});}
},30000);

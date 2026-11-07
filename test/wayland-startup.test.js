import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Owns a private compositor; never sends input to the user's desktop.
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('QML maps a startup frame before loading, replaces it, and can close during startup',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const {launch}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync(join(tmpdir(),'qml-startup-')),old=process.env.XDG_RUNTIME_DIR;
 let land,app,loading;
 const until=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await Bun.sleep(20)}throw Error('Startup window did not settle')};
 try{
  process.env.XDG_RUNTIME_DIR=dir;
  const file=join(dir,'main.qml');
  await Bun.write(file,'import QtQuick\nimport Quickshell\nFloatingWindow {title:"Ready";color:"#ff0000"}');
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  const surface=()=>land.compositor.wm.renderSurfaces().find(s=>s.pixels);
  loading=launch({socket:join(dir,'wayland-buninu'),url:Bun.pathToFileURL(file).href});
  await until(()=>surface());
  expect(land.compositor.wm.visible[0].surface.xdg.toplevel.title).toStartWith('Starting:');
  app=await loading;
  await until(()=>land.compositor.wm.visible[0]?.surface.xdg.toplevel.title==='Ready');
  expect(surface().pixels.width).toBe(app.window.width);
  app.close();await app.done;app=null;loading=null;
  await until(()=>land.compositor.wm.visible.length===0);
  loading=launch({socket:join(dir,'wayland-buninu'),url:Bun.pathToFileURL(file).href});
  await until(()=>surface());
  land.compositor.wm.close();
  app=await loading;
  await app.done;
  await until(()=>land.compositor.wm.visible.length===0);
 }finally{
  app?.close();land?.close();await loading?.catch(()=>{});
  if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;
  rmSync(dir,{recursive:true,force:true});
 }
},30000);

test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('HTML startup stays visible through a delayed response and resize, then becomes normal chrome',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const {launch}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync(join(tmpdir(),'html-startup-')),old=process.env.XDG_RUNTIME_DIR;
 const gate=Promise.withResolvers();let requested=false,land,app,loading,launched=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){requested=true;await gate.promise;return new Response('<title>HTML ready</title><body style="background:red">Ready</body>',{headers:{'content-type':'text/html'}})}});
 const until=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await Bun.sleep(20)}throw Error('HTML startup did not settle')};
 try{
  process.env.XDG_RUNTIME_DIR=dir;
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  const surface=()=>land.compositor.wm.renderSurfaces().find(s=>s.pixels);
  loading=launch({socket:join(dir,'wayland-buninu'),url:`http://127.0.0.1:${server.port}/`});
  loading.then(value=>{app=value;launched=true},()=>{});
  await until(()=>surface()&&requested);
  expect(launched).toBe(false);
  expect(land.compositor.wm.visible[0].surface.xdg.toplevel.title).toStartWith('Starting:');
  const before=surface().pixels.width;
  land.context.resize(900,700,1);
  await until(()=>surface().pixels.width!==before);
  expect(launched).toBe(false);
  gate.resolve();app=await loading;
  await until(()=>land.compositor.wm.visible[0]?.surface.xdg.toplevel.title==='HTML ready');
  expect(app.toolbar).toBeTruthy();
  expect(surface().pixels.width).toBe(app.window.width);
  app.close();await app.done;
 }finally{
  gate.resolve();app?.close();land?.close();await loading?.catch(()=>{});server.stop(true);
  if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;
  rmSync(dir,{recursive:true,force:true});
 }
},30000);

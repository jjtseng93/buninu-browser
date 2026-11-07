import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {test,expect} from 'bun:test';
import {encodeRequest,decode,interfaces} from '../frontends/wayland/protocol.js';
import {parseKeymap,keysym} from '../frontends/wayland/input.js';
import {chooseFrontend} from '../index.js';

test('Wayland launcher remains opt-in',()=>{
 expect(chooseFrontend(['--wayland','about:blank'])).toEqual({frontend:'wayland',args:['about:blank']});
 expect(chooseFrontend(['about:blank']).frontend).toBe('casty');
});
test('registry bind encodes dynamic new_id and SHM fd stays out of payload',()=>{
 const packet=encodeRequest(2,'wl_registry','bind',[7,'wl_compositor',4,3]);
 expect(decode(interfaces.get('wl_registry').requests[0],packet.data,[])).toEqual([7,'wl_compositor',4,3]);
 const pool=encodeRequest(4,'wl_shm','create_pool',[8,91,4096]);
 expect(pool.fds).toEqual([91]);expect(pool.data.length).toBe(16);
 expect(decode(interfaces.get('wl_shm').requests[0],pool.data,[91])).toEqual([8,91,4096]);
 expect(decode(interfaces.get('wl_shm').requests[0],pool.data,[])).toBeNull();
});
test('bounded keymap subset understands named and Unicode keysyms',()=>{
 const map=parseKeymap('<K30> = 38; key <K30> { type="ALPHABETIC", [ 0x61, 0x41 ] };');
 expect(map.get(30).map(keysym)).toEqual(['a','A']);expect(keysym('0x01004e2d')).toBe('中');
 expect(keysym('0xff0d')).toBe('Enter');expect(keysym('0xffe1')).toBeNull();expect(keysym('Left')).toBe('ArrowLeft');expect(keysym('dead_acute')).toBeNull();
});

// Optional sibling integration; never installs prerequisites or touches a running compositor.
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('Browser SHM, pointer, keyboard and resize in Land',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {start}=await import('../../buninu-land/compositor.js');
 const {launch}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync(join(tmpdir(), 'buninu-wayland-test-')),old=process.env.XDG_RUNTIME_DIR;
 process.env.XDG_RUNTIME_DIR=dir;let land,app;
 const wait=async(fn)=>{for(let i=0;i<500;i++){if(await fn())return;await Bun.sleep(20);}throw Error('Timed out waiting for Wayland state');};
 try{
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  app=await launch({socket:dir+'/wayland-buninu',url:'data:text/html,'+encodeURIComponent('<title>Ready</title><body style="margin:0;background:rgb(255,0,255)"><input id="text" style="width:200px;height:60px" oninput="document.title=this.value"><button style="position:absolute;left:0;top:100px;width:200px;height:60px" onclick="document.title=\'Clicked\'">Click</button>')});
  await wait(()=>land.compositor.wm.visible[0]?.surface.xdg.toplevel.title==='Ready');
  const surface=()=>land.compositor.wm.renderSurfaces().find(s=>s.pixels);
  await wait(()=>surface());expect(surface().pixels.width).toBe(app.window.width);
  const click=async(x,y)=>{const o=land.compositor.wm.origin(surface());for(const type of ['mouseMoved','mousePressed','mouseReleased'])land.context.dispatchMouseEvent({type,x:o.x+x,y:o.y+y,button:'left'});};
  await click(30,157);await wait(()=>land.compositor.wm.visible[0].surface.xdg.toplevel.title==='Clicked');
  await click(30,57);land.context.type('hello');
  await wait(()=>land.compositor.wm.visible[0].surface.xdg.toplevel.title==='hello');
  // Editing browser chrome must not suspend page frames. Conversely, blinking
  // chrome alone must reuse the last raw page frame rather than recapture it.
  let captures=0,presents=0;
  const screenshot=app.browser.context.screenshot.bind(app.browser.context);
  app.browser.context.screenshot=(...args)=>{captures++;return screenshot(...args);};
  const present=app.window.present.bind(app.window);
  app.window.present=(...args)=>{presents++;return present(...args);};
  await app.browser.context.evaluate('document.activeElement.blur()');
  app.toolbar.open();
  await Bun.sleep(800);
  const idleCaptures=captures,idlePresents=presents;
  await Bun.sleep(1100);
  expect(captures).toBe(idleCaptures);
  expect(presents).toBeGreaterThan(idlePresents);
  await app.browser.context.evaluate(`globalThis.animationTick=0;globalThis.animationTimer=setInterval(()=>{document.body.style.background=++animationTick%2?'red':'blue'},80)`);
  const animatedCaptures=captures,animatedPresents=presents;
  await wait(()=>captures>=animatedCaptures+3&&presents>=animatedPresents+3);
  expect(app.toolbar.editor.editing).toBe(true);
  expect(Number(await app.browser.context.evaluate('animationTick'))).toBeGreaterThan(2);
  await app.browser.context.evaluate('clearInterval(animationTimer)');
  app.toolbar.editor.cancelEditing();
  // Model Win32's raw key + WM_CHAR through Casty's no-shortcuts adapter,
  // Land and the real Wayland client, including the inner address editor.
  const {EventEmitter}=await import('node:events');
  const {startInputHandling}=await import('../../casty/lib/input.js');
  const {UrlBar,PromptHistory}=await import('../../casty/lib/urlbar.js');
  const outerClient=new EventEmitter();
  outerClient.send=async(method,p)=>{
    if(method==='Input.dispatchKeyEvent')return land.context.dispatchKeyEvent(p);
    if(method==='Input.insertText')return land.context.type(p.text);
    return {};
  };
  const outerBar=new UrlBar({history:new PromptHistory(null)});outerBar.native=true;outerBar.render=()=>{};
  const outer=startInputHandling(outerClient,1,1,1,{'ctrl+u':'back','ctrl+k':'forward'},()=>{},null,{},
    {noShortcuts:true,native:{urlBar:outerBar,quit(){}}});
  const physical=async(key,code,modifiers=0,text=null)=>{
    const info={key,code,keyCode:key.toUpperCase().charCodeAt(0),modifiers,eventType:1};
    await outer.dispatchNative('',info);
    if(text!==null)await outer.dispatchNativeText(text,info);
    await outer.dispatchNative('',{...info,eventType:3});
  };
  try{
    app.toolbar.open(false,'headtail');app.toolbar.editor.moveCursor(4);
    await physical('u','KeyU',2);await wait(()=>app.toolbar.editor.text==='tail');
    await physical('k','KeyK',2);await wait(()=>app.toolbar.editor.text==='');
    await physical('u','KeyU',2);await wait(()=>app.toolbar.editor.text==='head');
    await physical('k','KeyK',2);await wait(()=>app.toolbar.editor.text==='headtail');
    await physical('a','KeyA',0,'a');
    await wait(()=>app.toolbar.editor.text.length>8);await Bun.sleep(50);
    expect(app.toolbar.editor.text).toBe('headatail');
    const cursor=app.toolbar.editor.cursor;
    const left={key:'ArrowLeft',code:'ArrowLeft',keyCode:37,modifiers:0,eventType:1};
    await outer.dispatchNative('',left);
    await wait(()=>app.toolbar.editor.cursor<cursor-1);
    await outer.dispatchNative('',{...left,eventType:3});
    await Bun.sleep(50);const releasedCursor=app.toolbar.editor.cursor;
    await Bun.sleep(120);expect(app.toolbar.editor.cursor).toBe(releasedCursor);
    app.toolbar.editor.cancelEditing();
  }finally{outer.dispose();}
  // A JavaScript URL must present its modal while execution is blocked.
  let alertDone=false;
  const beforeAlert=presents;
  const alert=app.toolbar.navigate('javascript:alert(1)').then(()=>{alertDone=true;});
  await wait(()=>Boolean(app.browser.context.dialogState));
  await wait(()=>presents>beforeAlert);
  expect(alertDone).toBe(false);
  expect(await app.browser.context.evaluate('document.getElementById("message").textContent')).toBe('1');
  await app.toolbar.press('Enter');await alert;
  expect(app.browser.context.dialogState).toBe(null);
  // Ordinary navigation can also block on a load-time alert.
  const beforeLoadAlert=presents;
  const loading=app.toolbar.navigate('data:text/html,'+encodeURIComponent('<script>alert("load")</script><p>loaded</p>'));
  await wait(()=>Boolean(app.browser.context.dialogState));
  await wait(()=>presents>beforeLoadAlert);
  await app.toolbar.press('Enter');await loading;
  // A capture can fail after its modal renderer is retired. Simulate that
  // completion order explicitly instead of depending on renderer timing.
  const normalCapture=app.browser.context.screenshot;
  let rejectCapture,modalCaptureStarted=false;
  const beforeRetiredModal=presents;
  app.browser.context.screenshot=(...args)=>{
    if(app.browser.context.dialogState&&!modalCaptureStarted){
      modalCaptureStarted=true;
      return new Promise((_resolve,reject)=>{rejectCapture=reject;});
    }
    return normalCapture(...args);
  };
  try{
    const retiredModal=app.toolbar.navigate('javascript:alert("retire capture")');
    await wait(()=>modalCaptureStarted);
    await app.toolbar.press('Enter');
    rejectCapture(Error('compositor closed'));
    await retiredModal;
    await wait(()=>presents>beforeRetiredModal);
    expect(Boolean(app.window.closed)).toBe(false);
  }finally{app.browser.context.screenshot=normalCapture;}
  const before=app.window.width;land.context.resize(900,700,1);
  await wait(()=>app.window.width!==before&&surface().pixels.width===app.window.width);
  expect(JSON.parse(await app.browser.context.evaluate('JSON.stringify([innerWidth,innerHeight])'))).toEqual([app.window.width,app.window.height-32]);
  for(const type of ['keyDown','keyUp'])land.context.dispatchKeyEvent({type,key:'w',code:'KeyW',modifiers:4});
  await wait(()=>app.client.connection.closed&&land.compositor.wm.visible.length===0);
  await app.done;
  expect(app.window.closed).toBe(true);
 }finally{app?.close();land?.close();if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;rmSync(dir,{recursive:true,force:true});}
},30000);

test('Wayland input queued around close never calls the disposed renderer',async()=>{
 const {attachInput}=await import('../frontends/wayland/input.js');
 let capabilities,pointer,calls=0,errors=0,reject;
 const client={globals:new Map([['wl_seat',{}]]),connection:{closed:false},bind(_i,_v,fn){capabilities=fn;return 2;},object(iface,fn){if(iface==='wl_pointer')pointer=fn;return 3;},request(){}};
 const window={surface:4,closed:false};
 attachInput(client,window,{move(){calls++;return new Promise((_r,no)=>reject=no);}},()=>errors++);
 capabilities('capabilities',[1]);pointer('enter',[1,4,0,0]);pointer('motion',[1,3,4]);
 await Promise.resolve();expect(calls).toBe(1);
 window.closed=true;reject(Error('Renderer closed'));pointer('motion',[2,4,5]);
 await Bun.sleep(0);expect(calls).toBe(1);expect(errors).toBe(0);
});

// The initial URL must be able to display a modal before launch() resolves.
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('initial Wayland navigation presents a synchronous alert and accepts real keyboard input',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {start}=await import('../../buninu-land/compositor.js');
 const {launch}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync(join(tmpdir(), 'buninu-initial-alert-')),old=process.env.XDG_RUNTIME_DIR;
 process.env.XDG_RUNTIME_DIR=dir;let land,app,launching,launched=false;
 const until=async fn=>{for(let i=0;i<750;i++){if(fn())return;await Bun.sleep(20);}throw Error('Initial alert did not present');};
 try{
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  launching=launch({socket:dir+'/wayland-buninu',width:640,height:448,
    url:'data:text/html,'+encodeURIComponent('<script>alert("initial");document.title="Alert answered";</script><p>Ready</p>')});
  launching.then(value=>{app=value;launched=true;},()=>{});
  // The static startup frame is visible before input is ready; wait for the dialog.
  await until(()=>land.compositor.wm.renderSurfaces().some(s=>s.pixels)
    && !land.compositor.wm.visible[0]?.surface.xdg.toplevel.title.startsWith("Starting:"));
  expect(launched).toBe(false);
  // Non-background pixels demonstrate an actual dialog frame, not just a
  // mapped xdg_toplevel. Dismiss through the compositor's Wayland keyboard.
  const surface=land.compositor.wm.renderSurfaces().find(s=>s.pixels);
  expect(surface.pixels.width).toBeGreaterThan(0);
  await land.context.dispatchKeyEvent({type:'rawKeyDown',key:'Enter',code:'Enter'});
  await land.context.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter'});
  await until(()=>launched);
  app=await launching;
  expect(await app.browser.context.title()).toBe('Alert answered');
  expect(app.browser.context.dialogState).toBe(null);
 }finally{
  app?.close();land?.close();await launching?.catch(()=>{});
  if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;
  rmSync(dir,{recursive:true,force:true});
 }
},30000);

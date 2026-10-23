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
 const dir=mkdtempSync('/tmp/buninu-wayland-test-'),old=process.env.XDG_RUNTIME_DIR;
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

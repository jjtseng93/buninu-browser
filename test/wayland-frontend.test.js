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
  await click(30,125);await wait(()=>land.compositor.wm.visible[0].surface.xdg.toplevel.title==='Clicked');
  await click(30,25);land.context.type('hello');
  await wait(()=>land.compositor.wm.visible[0].surface.xdg.toplevel.title==='hello');
  const before=app.window.width;land.context.resize(900,700,1);
  await wait(()=>app.window.width!==before&&surface().pixels.width===app.window.width);
  expect(JSON.parse(await app.browser.context.evaluate('JSON.stringify([innerWidth,innerHeight])'))).toEqual([app.window.width,app.window.height]);
 }finally{app?.close();land?.close();if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;rmSync(dir,{recursive:true,force:true});}
},30000);

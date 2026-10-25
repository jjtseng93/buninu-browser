import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';

// Opt-in sibling integration, with its own socket; never touches the user's Land.
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('Casty SGR wheel -> Land -> browser scrolls both DOM axes',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const {mouseWheelEvent}=await import('../../casty/lib/input.js');
 const {launch}=await import('../frontends/wayland/index.js');
 const dir=mkdtempSync('/tmp/browser-wheel-'),old=process.env.XDG_RUNTIME_DIR;
 process.env.XDG_RUNTIME_DIR=dir;let land,app;
 const wait=async(fn)=>{for(let n=0;n<300;n++){if(await fn())return;await Bun.sleep(20)}throw Error('Scroll timed out')};
 try{
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  app=await launch({socket:dir+'/wayland-buninu',url:'data:text/html,'+encodeURIComponent('<style>body{margin:0}#box{width:400px;height:250px;overflow:auto}#content{width:1600px;height:1600px;background:linear-gradient(red,blue)}</style><div id="box"><div id="content"></div></div>')});
  const state=async()=>JSON.parse(await app.browser.context.evaluate('JSON.stringify([document.getElementById("box").scrollLeft,document.getElementById("box").scrollTop])'));
  await wait(()=>land.compositor.wm.renderSurfaces().some(s=>s.pixels));
  const surface=land.compositor.wm.renderSurfaces().find(s=>s.pixels),origin=land.compositor.wm.origin(surface);
  const wheel=code=>land.context.dispatchMouseEvent(mouseWheelEvent(code,origin.x+100,origin.y+130));
  wheel(67);await wait(async()=>(await state())[0]>0);
  const right=await state();expect(right[1]).toBe(0);
  wheel(65);await wait(async()=>(await state())[1]>0);
  const down=await state();expect(down[0]).toBe(right[0]);
  wheel(66);await wait(async()=>(await state())[0]<right[0]);
  wheel(64);await wait(async()=>(await state())[1]<down[1]);
  expect(await state()).toEqual([0,0]);
 }finally{app?.close();land?.close();if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;rmSync(dir,{recursive:true,force:true})}
},30000);

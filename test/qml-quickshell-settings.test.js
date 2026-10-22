// Opt-in binary comparison. No Quickshell source or dependency installation.
// BUNINU_QS_ROOT=/path/to/extracted/sid/root bun test test/qml-quickshell-settings.test.js
import {test,expect} from 'bun:test';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const qsRoot=process.env.BUNINU_QS_ROOT;
test.skipIf(!qsRoot)('real Quickshell SettingsRuler matches size, disabled tap and reset behavior',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const dir=mkdtempSync('/tmp/qs-settings-test-'),fixture=join(dir,'fixture'),home=join(dir,'home');
 const oldRuntime=process.env.XDG_RUNTIME_DIR;
 let land,child;
 try{
  cpSync(Bun.fileURLToPath(new URL('./fixtures/qml/flea-theme/',import.meta.url)),fixture,{recursive:true});
  // Qt validates all declared types, including ones not used by this subset.
  // Trim only the temporary module indexes; all actual QML/JS stays unchanged.
  const trim=path=>{
   for(const e of readdirSync(path,{withFileTypes:true})){
    const p=join(path,e.name);
    if(e.isDirectory())trim(p);
    else if(e.name==='qmldir')writeFileSync(p,readFileSync(p,'utf8').split('\n').filter(line=>{
     const last=line.trim().split(/\s+/).at(-1);
     return !last.endsWith('.qml')||existsSync(join(path,last));
    }).join('\n'));
   }
  };trim(fixture);
  const theme=join(home,'.local/state/omarchy/current/theme');mkdirSync(theme,{recursive:true});
  writeFileSync(join(theme,'shell.toml'),'[font]\nbase-size = 14\n');
  writeFileSync(join(theme,'colors.toml'),'background="#101315"\nforeground="#eeeeee"\naccent="#70e1e8"\n');
  writeFileSync(join(theme,'../theme.name'),'demo');
  process.env.XDG_RUNTIME_DIR=dir;
  land=await start(['--remote-debugging-port=0','--window-size=1000,700']);
  const lib=join(qsRoot,'usr/lib/aarch64-linux-gnu');
  child=Bun.spawn([join(lib,'ld-linux-aarch64.so.1'),'--library-path',lib+':'+join(qsRoot,'usr/lib'),join(qsRoot,'usr/bin/qs'),'-p',join(fixture,'settings.qml')],{
   env:{...process.env,HOME:home,HYPRLAND_INSTANCE_SIGNATURE:'',WAYLAND_DISPLAY:'wayland-buninu',QT_PLUGIN_PATH:join(lib,'qt6/plugins'),QML_IMPORT_PATH:join(fixture,'imports')+':'+join(lib,'qt6/qml'),QT_QPA_PLATFORM:'wayland',QT_WAYLAND_DISABLE_WINDOWDECORATION:'1',QT_QUICK_BACKEND:'software'},
   stdout:'ignore',stderr:'pipe'
  });
  const logs=new Response(child.stderr).text();
  const title=()=>land.compositor.wm.visible[0]?.surface.xdg.toplevel.title;
  const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;if(child.exitCode!==null)throw Error(await logs);await Bun.sleep(50);}throw Error('Quickshell state timed out: '+title());};
  await until(()=>title()==='Flea — text size settings | 14 | 0');
  const click=async(x,y)=>{
   const surface=land.compositor.wm.renderSurfaces().find(s=>s.pixels);
   const o=land.compositor.wm.origin(surface);
   for(const type of ['mouseMoved','mousePressed','mouseReleased'])land.context.dispatchMouseEvent({type,x:o.x+x,y:o.y+y,button:'left'});
   await Bun.sleep(120);
  };
  await Bun.sleep(500);
  await Bun.write('/tmp/qs-settings-before.png',Buffer.from(await land.context.screenshot({format:'png'}),'base64'));
  await click(712,100);await until(()=>title()==='Flea — text size settings | 20 | 1');
  await click(100,300);await click(76,100);
  expect(title()).toBe('Flea — text size settings | 20 | 1');
  await click(100,300);await click(76,100);await until(()=>title()==='Flea — text size settings | 9 | 2');
  await click(380,300);await until(()=>title()==='Flea — text size settings | 14 | 2');
  await Bun.write('/tmp/quickshell-flea-settings.png',Buffer.from(await land.context.screenshot({format:'png'}),'base64'));
  expect(title()).toBe('Flea — text size settings | 14 | 2');
 }finally{
  if(child){child.kill();await child.exited;}
  land?.close();
  if(oldRuntime===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=oldRuntime;
  rmSync(dir,{recursive:true,force:true});
 }
},30000);

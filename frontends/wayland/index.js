import {readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBrowser} from '../../lib/headless-shell.js';
import {WaylandClient,WaylandWindow} from './client.js';
import {attachInput} from './input.js';
import {attachClipboard} from './clipboard.js';
import {WaylandUrlBar,BAR_HEIGHT} from './urlbar.js';
import {readClipboard,writeClipboard} from '../../lib/clipboard.js';

// qml handle begin: local QML clipboard uses this frontend's Wayland seat
import {attachQmlClipboard} from '../../lib/qml/wayland-clipboard.js';
// qml handle end

export async function launch({url='about:blank',width=800,height=600,socket,chrome}={}) {
  // qml handle begin: local application windows default to no browser chrome
  chrome ??= !/\.qml(?:[?#]|$)/i.test(url);
  // qml handle end

  let browser,client,window,off,titleTimer,toolbar,closed=false,busy=false,dirty=true,ready=false;
  let pageDirty=true,pageBytes,pageSize='',navigation=0,navigating=0;
  let resolveDone;const done=new Promise(resolve=>resolveDone=resolve);
  const close=()=>{if(closed)return;closed=true;clearInterval(titleTimer);off?.();toolbar?.dispose();try{window?.close();}finally{client?.close();browser?.close();resolveDone();}};
  const fail=e=>{console.error(`Wayland frontend: ${e.message}`);close();};
  try{
    client=new WaylandClient(socket);await client.initialize();
    attachClipboard(client,done);
    const clipboard={
      read:async()=>{
        if(client.clipboard?.selection)return client.clipboard.read();
        const text=await readClipboard();
        // A successful host paste seeds the compositor's text cache too.
        if(text&&client.clipboard?.serial)await client.clipboard.write(text);
        return text;
      },
      write:text=>client.clipboard?client.clipboard.write(text):writeClipboard(text),
    };
    browser=await createBrowser({spareRenderer:false,clipboard});

    // qml handle begin: operation-triggered local QML clipboard bridge
    await attachQmlClipboard(client,browser,done);
    // qml handle end

    if(chrome ?? true)toolbar=await new WaylandUrlBar(browser.context,{
      close,changed:()=>{dirty=true;if(ready)void draw();},
      clipboard,
    }).initialize();
    window=new WaylandWindow(client,{width,height:height+(toolbar?BAR_HEIGHT:0)});
    client.onClose=close;window.onClose=close;
    const draw=async()=>{
      if(closed||!ready||navigating||busy||!dirty||!window.available)return;
      busy=true;dirty=false;const generation=navigation;let path;
      try{
        const w=window.width,h=window.height,bar=toolbar?Math.min(BAR_HEIGHT,h-1):0,z=toolbar?.zoom||1;
        const size=`${w}:${h}:${z}`;
        if(pageDirty||pageSize!==size||!pageBytes){
          pageDirty=false;
          if(pageSize!==size)await browser.context.resize(w/z,(h-bar)/z,z);
          const frame=JSON.parse(await browser.context.screenshot({format:'bgra'}));path=frame.path;
          if(closed||generation!==navigation)return;
          if(frame.transport!=='file'||frame.format!=='bgra'||frame.stride!==frame.width*4)throw Error('Unexpected raw frame');
          const pixels=readFileSync(path);
          if(frame.width===w&&frame.height===h-bar)pageBytes=pixels;
          else {
            pageBytes=Buffer.alloc(w*(h-bar)*4,255);
            for(let row=0;row<Math.min(frame.height,h-bar);row++)pixels.copy(pageBytes,row*w*4,row*frame.stride,row*frame.stride+Math.min(w,frame.width)*4);
          }
          pageSize=size;
        }
        toolbar?.updateURL(browser.context.url);
        const parts=toolbar?[toolbar.pixels(w).subarray(0,w*bar*4),pageBytes]:pageBytes;
        if(!closed&&!window.present(parts,w,h))dirty=true;
        if(!closed){const title=String(await browser.context.title()||'Buninu Browser');if(generation===navigation&&!closed)client.request(window.toplevel,'set_title',title);}
      }catch(e){if(!closed&&generation===navigation)fail(e);}finally{if(path)try{unlinkSync(path);}catch{}busy=false;if(!closed&&dirty&&window.available)setTimeout(draw,0);}
    };
    // Actual navigation may replace the renderer. Ignore work from the old
    // document and resume drawing once navigation settles. Editing chrome does
    // not enter this path and continues to present page animation normally.
    const navigate=browser.context.navigate;
    browser.context.navigate=async function(...args){
      navigation++;navigating++;
      try{return await navigate.apply(this,args);}
      finally{navigating--;pageDirty=true;dirty=true;if(ready&&!closed)void draw();}
    };
    let readingTitle=false,lastTitle='';
    titleTimer=setInterval(async()=>{
      if(closed||!ready||navigating||readingTitle)return;
      readingTitle=true;const generation=navigation;
      try{
        const title=String(await browser.context.title()||'Buninu Browser');
        if(closed||generation!==navigation)return;
        toolbar?.updateURL(browser.context.url);
        if(title!==lastTitle){lastTitle=title;client.request(window.toplevel,'set_title',title);}
      }catch(e){if(!closed&&generation===navigation)fail(e);}finally{readingTitle=false;}
    },500);
    window.onConfigure=()=>{pageDirty=true;dirty=true;draw();};window.onReady=draw;
    off=browser.context.onFrame(()=>{pageDirty=true;dirty=true;draw();});
    const input=toolbar?{
      press:(...args)=>toolbar.press(...args).catch(e=>toolbar.flash(e.message)),
      pointerButton:(...args)=>toolbar.pointerButton(...args).catch(e=>toolbar.flash(e.message)),
      move:(...args)=>toolbar.move(...args),scroll:(...args)=>toolbar.scroll(...args),
    }:browser.context;
    attachInput(client,window,input,fail);
    await browser.context.resize(width,height,1);await browser.context.navigate(url);ready=true;draw();
    return {browser,client,window,toolbar,close,done};
  }catch(e){close();throw e;}
}
if(import.meta.main){
  const args=Bun.argv.slice(2).filter(a=>a!=='--');
  if(args.some(a=>['-h','--help'].includes(a))){console.log('Usage: buninu-browser --wayland [URL or file] [--window-size=800,600]\nUses WAYLAND_DISPLAY and XDG_RUNTIME_DIR. Experimental wl_shm frontend.');process.exit(0);}
  let width=800,height=600,url='about:blank';
  for(const arg of args){if(arg.startsWith('--window-size=')){[width,height]=arg.slice(14).split(',').map(Number);}else if(arg.startsWith('-'))throw Error(`Unknown Wayland option: ${arg}`);else url=arg;}
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192)throw Error('Invalid window size');
  if(!/^[a-z][a-z\d+.-]*:/i.test(url))url=url.startsWith('/')||url.startsWith('.')?pathToFileURL(resolve(url)).href:`https://${url}`;
  const app=await launch({url,width,height});for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,app.close);await app.done;
}

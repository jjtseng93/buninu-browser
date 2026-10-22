import {readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBrowser} from '../../lib/headless-shell.js';
import {WaylandClient,WaylandWindow} from './client.js';
import {attachInput} from './input.js';

export async function launch({url='about:blank',width=800,height=600,socket}={}) {
  let browser,client,window,off,titleTimer,closed=false,busy=false,dirty=true,ready=false;
  let resolveDone;const done=new Promise(resolve=>resolveDone=resolve);
  const close=()=>{if(closed)return;closed=true;clearInterval(titleTimer);off?.();try{window?.close();}finally{client?.close();browser?.close();resolveDone();}};
  const fail=e=>{console.error(`Wayland frontend: ${e.message}`);close();};
  try{
    client=new WaylandClient(socket);await client.initialize();browser=await createBrowser({spareRenderer:false});
    window=new WaylandWindow(client,{width,height});
    client.onClose=close;window.onClose=close;
    const draw=async()=>{
      if(closed||!ready||busy||!dirty||!window.available)return;
      busy=true;dirty=false;let path;
      try{
        const w=window.width,h=window.height;
        await browser.context.resize(w,h,1);
        const frame=JSON.parse(await browser.context.screenshot({format:'bgra'}));path=frame.path;
        if(frame.transport!=='file'||frame.format!=='bgra'||frame.stride!==frame.width*4)throw Error('Unexpected raw frame');
        if(!closed&&!window.present(readFileSync(path),frame.width,frame.height))dirty=true;
        if(!closed)client.request(window.toplevel,'set_title',String(await browser.context.title()||'Buninu Browser'));
      }catch(e){if(!closed)fail(e);}finally{if(path)try{unlinkSync(path);}catch{}busy=false;if(!closed&&dirty&&window.available)setTimeout(draw,0);}
    };
    let readingTitle=false,lastTitle='';
    titleTimer=setInterval(async()=>{
      if(closed||readingTitle)return;readingTitle=true;
      try{const title=String(await browser.context.title()||'Buninu Browser');if(!closed&&title!==lastTitle){lastTitle=title;client.request(window.toplevel,'set_title',title);}}
      catch(e){if(!closed)fail(e);}finally{readingTitle=false;}
    },500);
    window.onConfigure=()=>{dirty=true;draw();};window.onReady=draw;
    off=browser.context.onFrame(()=>{dirty=true;draw();});attachInput(client,window,browser.context,fail);
    await browser.context.resize(width,height,1);await browser.context.navigate(url);ready=true;draw();
    return {browser,client,window,close,done};
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

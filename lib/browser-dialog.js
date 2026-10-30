import {FilePicker} from './file-picker.js';
import {writeClipboard} from "./clipboard.js";
import {RendererHost} from './renderer/host.js';

// Browser-owned modal UI, isolated from the page's DOM and JavaScript realm.
// Reuse the normal HTML renderer for scrolling, selection, caret and clipboard.
export class BrowserDialog {
  constructor({viewport, background, changed, opened, closed, clipboard}) {
    Object.assign(this,{viewport,background,changed,opened,closed,clipboard});
    this.active=null;
  }
  open(request,signal) {
    if(signal?.aborted)return Promise.resolve({accept:false});
    if(this.active)return Promise.resolve({accept:false});
    const answer=Promise.withResolvers();
    const entry={request,answer,host:null,ready:null};this.active=entry;
    entry.abort=()=>this.finish({accept:false},entry);entry.signal=signal;
    signal?.addEventListener('abort',entry.abort,{once:true});
    entry.ready=this.prepare(entry).catch(error=>{if(this.active===entry)console.error('buninu-browser: dialog:',error.message);this.finish({accept:false},entry);});
    this.opened(request);
    return answer.promise;
  }
  async prepare(entry) {
    const size=this.viewport();
    // Capture directly from the compositor: page scripts may be paused in load.
    let background='';try{background=await this.background();}catch{}
    if(this.active!==entry)return;
    const host=new RendererHost({onFrame:()=>{if(this.active===entry)this.changed();},
      ...(this.clipboard?{clipboardRead:()=>this.clipboard.read(),clipboardWrite:text=>this.clipboard.write(text)}:{})});
    entry.host=host;
    await host.call('resize',size.width,size.height,size.deviceScaleFactor);
    entry.background=background;
    if(entry.request.type==='file'){entry.picker=new FilePicker(entry.request);await entry.picker.browse('.');}
    await host.call('loadDocument',{url:'about:dialog',source:entry.picker?entry.picker.document(size,background):dialogDocument(entry.request,size,background),contentType:'text/html'});
    if(this.active===entry)this.changed();
  }
  async invoke(method,...args) {
    const entry=this.active;if(!entry)return;
    await entry.ready;
    if(this.active!==entry||!entry.host)return;
    if(method==='press' && (args[1]?.modifiers & 6) && String(args[0]).toLowerCase()==='c') {
      const selected=await entry.host.call('evaluate','window.getSelection().toString()');
      if(selected){if(this.clipboard)await this.clipboard.write(selected);else await writeClipboard(selected);return;}
    }
    const value=method==='screenshot'||method==='scrollOffset'||method==='scroll'
      ? await entry.host.composite(method,...args):await entry.host.call(method,...args);
    if(['press','type','click'].includes(method)) {
      if(entry.picker){const action=await entry.host.call('evaluate','window.__fileAction');
        if(action){await entry.host.call('evaluate','window.__fileAction=null');
          const directory=entry.picker.directory;
          const scroll=await entry.host.call('evaluate','[document.getElementById("message").scrollTop,document.getElementById("dialog").scrollTop]');
          const answer=await entry.picker.action(action);
          if(answer){this.finish(answer,entry);return value;}
          await entry.host.call('loadDocument',{url:'about:dialog',source:entry.picker.document(this.viewport(),entry.background),contentType:'text/html'});
          if(directory===entry.picker.directory)await entry.host.call('evaluate',`document.getElementById('message').scrollTop=${Number(scroll?.[0])||0};document.getElementById('dialog').scrollTop=${Number(scroll?.[1])||0}`);
          this.changed();}
      }
      const result=await entry.host.call('evaluate','window.__dialogAnswer');
      if(result && typeof result.accept==='boolean')this.finish(result,entry);
    }
    return value;
  }
  async resize(width,height,dpr) {
    const entry=this.active;if(!entry)return;
    await entry.ready;if(this.active!==entry)return;
    await entry.host.call('resize',width,height,dpr);
    const w=Math.max(1,Math.min(entry.picker?720:480,width-24)),x=Math.max(0,(width-w)/2),y=Math.min(48,Math.max(0,height/12));
    await entry.host.call('evaluate',`Object.assign(document.getElementById('dialog').style,{width:'${w}px',left:'${x}px',top:'${y}px',maxHeight:'${Math.max(1,height-y-8)}px'});document.getElementById('message').style.maxHeight='${Math.max(20,height-y-180)}px';`);
    this.changed();
  }
  finish(result,entry=this.active) {
    if(!entry||this.active!==entry)return;
    this.active=null;
    entry.signal?.removeEventListener('abort',entry.abort);
    entry.host?.close();
    entry.answer.resolve({accept:Boolean(result.accept),promptText:String(result.promptText??''),...(entry.picker?{files:result.files??[]}: {})});
    this.closed(result);this.changed();
  }
  close(){this.finish({accept:false});}
}

export function dialogDocument({type,message,defaultPrompt='',url=''}, {width,height}, background='') {
  const escape=value=>Bun.escapeHTML(String(value));
  const w=Math.max(1,Math.min(480,width-24)),x=Math.max(0,(width-w)/2),y=Math.min(48,Math.max(0,height/12));
  const maxMessage=Math.max(20,height-y-180);
  let origin;try{origin=new URL(url).origin;}catch{origin='';}
  if(!origin||origin==='null')origin='This page';
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;font:16px sans-serif;color:#202124}
body{background:#444}#background{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none}
#shade{position:fixed;inset:0;background:rgba(0,0,0,.4)}
#dialog{position:absolute;left:${x}px;top:${y}px;width:${w}px;max-height:${Math.max(1,height-y-8)}px;overflow:auto;box-sizing:border-box;padding:20px;background:#fff;border:1px solid #aaa;border-radius:12px}
h2{font-size:16px;margin:0 0 16px}#message{white-space:pre-wrap;overflow-wrap:anywhere;max-height:${maxMessage}px;overflow:auto;user-select:text;margin-bottom:16px;outline:none}
input{display:block;box-sizing:border-box;width:100%;font:16px sans-serif;padding:8px;margin-bottom:16px}
#buttons{display:flex;justify-content:flex-end;gap:8px}button{font:14px sans-serif;padding:8px 18px;border:1px solid #888;border-radius:6px;background:#fff;color:#202124}#ok{background:#1769d2;color:white}
</style>${background?`<img id="background" src="data:image/png;base64,${background}">`:''}<div id="shade"></div><section id="dialog" role="${type==='alert'?'alertdialog':'dialog'}" aria-modal="true" aria-labelledby="heading" aria-describedby="message">
<h2 id="heading">${escape(origin)} says</h2><div id="message" tabindex="0">${escape(message)}</div>
${type==='prompt'?`<input id="answer" aria-label="Response" value="${escape(defaultPrompt)}">`:''}
<div id="buttons">${type!=='alert'?'<button id="cancel" onclick="finish(false)">Cancel</button>':''}<button id="ok" onclick="finish(true)">OK</button></div></section>
<script>
window.__dialogAnswer=null;
function finish(accept){window.__dialogAnswer={accept:accept,promptText:document.getElementById('answer')?.value||''};}
document.addEventListener('keydown',function(e){
  const active=document.activeElement;
  if(e.key==='Escape'){e.preventDefault();finish(false);}
  else if(e.key==='Enter'||(e.key===' '&&active?.tagName==='BUTTON')){e.preventDefault();finish(active?.id!=='cancel');}
  else if(active?.tagName!=='INPUT'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    const message=document.getElementById('message'),step=Math.max(20,message.clientHeight-20);
    const delta={ArrowUp:-31,ArrowDown:31,PageUp:-step,PageDown:step,' ':step}[e.key];
    if(delta!==undefined){e.preventDefault();message.scrollTop+=delta;}
    else if(e.key==='Home'||e.key==='End'){e.preventDefault();message.scrollTop=e.key==='Home'?0:message.scrollHeight;}
  }
});
const input=document.getElementById('answer');if(input){input.focus();input.select();}else document.getElementById('message').focus();
</script>`;
}

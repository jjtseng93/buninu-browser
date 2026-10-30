import {readdir,stat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
const esc=value=>Bun.escapeHTML(String(value));
export class FilePicker {
 constructor(request){this.request=request;this.directory=homedir();this.selected=new Map();this.entries=[];this.error='';}
 async browse(path){
  try {const directory=await realpath(resolve(this.directory,path));const entries=await readdir(directory,{withFileTypes:true});
   this.directory=directory;this.entries=[];
   for(const e of entries){let folder=e.isDirectory();if(e.isSymbolicLink()){try{folder=(await stat(resolve(directory,e.name))).isDirectory();}catch{continue;}}
    this.entries.push({name:e.name,path:resolve(directory,e.name),folder});}
   this.entries.sort((a,b)=>Number(b.folder)-Number(a.folder)||a.name.localeCompare(b.name));this.error='';
  }catch(e){this.error=e.message;}
 }
 async action(action){
  if(action.kind==='browse'){await this.browse(action.path);return;}
  if(action.kind==='up'){await this.browse(dirname(this.directory));return;}
  if(action.kind==='select'){
   const entry=this.entries[action.index];if(!entry)return;
   if(entry.folder){await this.browse(entry.path);return;}
   if(this.selected.has(entry.path))this.selected.delete(entry.path);
   else {if(!this.request.multiple)this.selected.clear();this.selected.set(entry.path,entry.name);}return;
  }
  if(action.kind==='open'){
   try{const files=[];let total=0;
    for(const [path,name] of this.selected){const file=Bun.file(path);const info=await stat(path);if(!info.isFile())continue;
     total+=info.size;if(total>32*1024*1024)throw Error('Please select at most 32 MiB at a time.');
     const bytes=new Uint8Array(await file.slice(0,info.size+1).arrayBuffer());
     if(bytes.length>info.size)throw Error('The selected file changed; please select it again.');
     files.push({name,type:file.type,lastModified:info.mtimeMs,data:bytes.toBase64()});}
    if(files.length)return {accept:true,files};
   }catch(e){this.error=e.message;}
  }
 }
 document({width,height},background=''){
  const w=Math.max(1,Math.min(720,width-24)),h=Math.max(80,height-100);
  const entries=this.entries.map((e,index)=>`<button class="entry" onclick="act({kind:'select',index:${index}})">${this.selected.has(e.path)?'☑ ':''}${e.folder?'📁':/\.(png|jpe?g|webp|gif|svg)$/i.test(e.name)?'🖼️':/\.(mp3|wav|ogg)$/i.test(e.name)?'🎵':'📄'} ${esc(e.name)}</button>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:16px sans-serif;color:#202124;background:#444}#background{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}#shade{position:fixed;inset:0;background:rgba(0,0,0,.4)}
#dialog{position:absolute;left:${Math.max(0,(width-w)/2)}px;top:24px;width:${w}px;max-height:${height-32}px;box-sizing:border-box;overflow:auto;background:white;padding:16px;border:1px solid #aaa;border-radius:10px}
h2{font-size:18px;margin:0 0 12px}input{width:100%;box-sizing:border-box;font:16px sans-serif;padding:6px}button{font:16px sans-serif;padding:7px;margin:2px;border:1px solid #bbb;border-radius:4px;background:#fafafa;color:#111}
#message{max-height:${Math.max(50,h-220)}px;overflow:auto}.entry{display:block;width:98%;text-align:left;overflow-wrap:anywhere}.footer{margin-top:10px}#error{color:#a00}#chosen{font-size:13px;overflow-wrap:anywhere}</style>
${background?`<img id="background" src="data:image/png;base64,${background}">`:''}<div id="shade"></div><section id="dialog" role="dialog" aria-modal="true"><h2>Choose ${this.request.multiple?'files':'a file'}</h2>
<input id="path" aria-label="Folder" value="${esc(this.directory)}"><button onclick="act({kind:'browse',path:document.getElementById('path').value})">Go</button><button onclick="act({kind:'up'})">📁 Up</button>
<div id="error">${esc(this.error)}</div><div id="message">${entries||'Empty folder'}</div><div id="chosen">${esc([...this.selected.values()].join(', '))}</div><div class="footer"><button onclick="window.__dialogAnswer={accept:false}">Cancel</button><button onclick="act({kind:'open'})">Open</button></div></section>
<script>window.__dialogAnswer=null;window.__fileAction=null;function act(a){window.__fileAction=a;}document.addEventListener('keydown',e=>{if(e.key==='Escape')window.__dialogAnswer={accept:false};else if(e.key==='Enter'){e.preventDefault();act(document.activeElement.id==='path'?{kind:'browse',path:document.getElementById('path').value}:{kind:'open'});}});</script>`;
 }
}

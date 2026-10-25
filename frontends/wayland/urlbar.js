// Casty's editor is vendored beside this adapter. Only rendering and browser
// actions live here; selection, history, dragging and double clicks stay there.
import {UrlBar,PromptHistory,toURL} from './casty/urlbar.js';
import {COMMANDS,parseCommand,parseZoom} from './casty/commands.js';
import {loadKeyBindings,toKeyName} from './casty/keys.js';
import {loadConfig} from './casty/config.js';
import {searchBookmarks} from './casty/bookmarks.js';
import {displayWidth,fitWidth} from './casty/prompt-width.js';
import {downloadPage} from './casty/download.js';
import {HintMode} from './casty/hints.js';
import {findInPage,toggleEruda} from './casty/page-commands.js';
import {readClipboard,writeClipboard} from '../../lib/clipboard.js';

export const BAR_HEIGHT=32;
export const WAYLAND_COMMANDS=COMMANDS.filter(c=>!['cdp','kitty','pixelmouse'].includes(c.name));
export function editorKey(key,modifiers=0) {
  const letters={ArrowUp:'A',ArrowDown:'B',ArrowRight:'C',ArrowLeft:'D',Home:'H',End:'F'};
  if(letters[key])return `\x1b[${modifiers?`1;${1+(modifiers&8?1:0)+(modifiers&1?2:0)+(modifiers&2?4:0)}`:''}${letters[key]}`;
  if(key==='Delete')return '\x1b[3~';
  if(key==='Backspace')return '\x7f';
  if(key==='Enter')return '\r';if(key==='Escape')return '\x1b';if(key==='Tab')return '\t';
  if(modifiers&2&&/^[a-z]$/i.test(key))return String.fromCharCode(key.toLowerCase().charCodeAt(0)-96);
  return key.length===1||[...key].length===1?key:'';
}
class PixelEditor extends UrlBar {
  constructor(onChange,history) {super({history,commandEntry:true});this.changed=onChange;this.columns=80;}
  render(){this._dirty=false;this.changed?.();}
}
export class WaylandUrlBar {
  constructor(context,{changed=()=>{},close=()=>{},clipboard=null,history=new PromptHistory()}={}) {
    this.context=context;this.changed=changed;this.quit=close;this.height=BAR_HEIGHT;
    this.clipboard=clipboard||{read:readClipboard,write:writeClipboard};
    this.editor=new PixelEditor(()=>{this.dirty=true;this.caret=true;changed();},history);
    this.bindings=loadKeyBindings();this.zoom=1;this.width=0;this.cellWidth=10;this.cache=new Map();
    this.client={send:(method,params)=>this.send(method,params)};
    this.hints=new HintMode(changed);
    this.timer=setInterval(()=>{if(this.editor.editing){this.caret=!this.caret;this.dirty=true;changed();}},500);
    this.timer.unref?.();this.dirty=true;
  }
  async initialize() {
    const {loadGraphics}=await import('../../lib/renderer/page-renderer.js');
    this.graphics=await loadGraphics();
    const paragraph=this.paragraph('M','#ffffff');this.cellWidth=paragraph.getMaxIntrinsicWidth();
    return this;
  }
  updateURL(url){if(url!==this.editor.currentUrl)this.editor.setUrl(url||'about:blank');}
  flash(text){clearTimeout(this.statusTimer);this.editor.setStatus(String(text));this.editor.render();this.statusTimer=setTimeout(()=>{this.editor.clearStatus();this.editor.render();},5000);}
  open(command=false,text=null){if(this.editor.editing)this.editor.cancelEditing();this.editor.startEditing({command,text}).then(result=>{
    if(result?.mode==='cmd')return this.command(result.line);
    if(result?.url)return this.navigate(result.url);
  }).catch(error=>this.flash(error.message));}
  async navigate(url){this.editor.loading=true;this.editor.render();try{await this.context.navigate(url);this.updateURL(this.context.url);}finally{this.editor.loading=false;this.editor.render();this.changed();}}
  async press(key,options={}) {
    const m=options.modifiers||0,name=toKeyName({key,modifiers:m});
    if(this.editor.editing) {
      if(name==='ctrl+c'||name==='alt+c')await this.clipboard.write(this.editor.selectedText||this.editor.text);
      else if(name==='ctrl+x') {if(this.editor.selectedText){await this.clipboard.write(this.editor.selectedText);this.editor._clearIfSelected();this.editor.render();}}
      else if(name==='ctrl+v')this.editor.insertText((await this.clipboard.read()).replace(/[\r\n]+/g,' '));
      else this.editor.handleInput(editorKey(key,m));
      return;
    }
    if(this.hints.active){await this.hints.handleInput(editorKey(key,m));return;}
    const action=this.bindings[name];
    // Native page editing must receive Ctrl-V itself (including preventDefault,
    // selection replacement and beforeinput), using the frontend clipboard.
    if(action==='paste')return this.context.press(key,options);
    if(action){await this.action(action);return;}
    return this.context.press(key,options);
  }
  async pointerButton(x,y,button,state,options={}) {
    if(button<272||button>274)return;
    if(y<this.height||this.editor.dragging) {
      if(button!==272)return;
      const col=Math.max(1,Math.floor(x/this.cellWidth)+1);
      if(state) {
        if(!this.editor.editing){this.open(col<=3);if(col>3)this.editor.armDrag(col);}
        else this.editor.pointerDown(col);
      }else this.editor.pointerUp();
      return;
    }
    if(state&&this.editor.editing)this.editor.cancelEditing();
    if(!state)return this.context.click(x/this.zoom,(y-this.height)/this.zoom,button===272?options:{...options,button:button===273?"right":"middle"});
  }
  move(x,y){if(this.editor.dragging){this.editor.pointerMove(Math.max(1,Math.floor(x/this.cellWidth)+1));return;}if(y>=this.height)return this.context.move(x/this.zoom,(y-this.height)/this.zoom);}
  scroll(dx,dy,at){if(at?.y<this.height){if(this.editor.editing){if(dy<0)this.editor.historyUp();else this.editor.historyDown();}return;}return this.context.scroll(dx/this.zoom,dy/this.zoom,at?{x:at.x/this.zoom,y:(at.y-this.height)/this.zoom}:null);}
  async command(line) {
    const {name,arg,error}=parseCommand(line);if(error){this.flash(error);return;}
    if(!WAYLAND_COMMANDS.some(c=>c.name===name)){this.flash(`${name} is not used by the Wayland frontend`);return;}
    if(name==='open'){const url=toURL(arg);if(url)await this.navigate(url);else this.flash('Bookmark not found');}
    else if(name==='bookmark'){const match=searchBookmarks(arg)[0];if(match)await this.navigate(match.url);else this.flash('Bookmark not found');}
    else if(name==='help')this.flash(WAYLAND_COMMANDS.map(c=>c.usage).join(' · '));
    else if(name==='find'){const result=await findInPage(this.client,arg);this.flash(result.error||`${result.text}: ${result.total?result.index+1:0}/${result.total}`);}
    else if(name==='zoom'){if(!arg)this.flash(`Zoom ${Math.round(this.zoom*100)}%`);else{const zoom=parseZoom(arg,this.zoom);if(zoom===null)this.flash('Invalid zoom');else{this.zoom=zoom;this.changed();}}}
    else await this.action({links:'hints',copyurl:'copy_url',pasteurl:'paste_url'}[name]||name);
  }
  async action(action) {
    if(action==='quit'){this.quit();return;}
    if(action==='url_bar'){this.open();return;}
    if(action==='command'){this.open(true);return;}
    if(action==='paste_url'){this.open(false,(await this.clipboard.read()).replace(/[\r\n]+/g,' '));return;}
    if(action==='back')await this.context.goBack();
    else if(action==='forward')await this.context.goForward();
    else if(action==='reload')await this.context.reload();
    else if(action==='home')await this.navigate(toURL(loadConfig().homeUrl));
    else if(action==='copy_url'){await this.clipboard.write(this.context.url);this.flash('Copied URL');}
    else if(action==='copy'){
      const text=await this.context.evaluate(`(()=>{const e=document.activeElement;return e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):String(getSelection())})()`);
      if(text)await this.clipboard.write(text);
    }else if(action==='paste')await this.context.type(await this.clipboard.read());
    else if(action==='download')this.flash('Saved: '+await downloadPage(this.client));
    else if(action==='hints'){void this.hints.start(this.client).catch(e=>this.flash(e.message));}
    else if(action==='eruda')this.flash(await toggleEruda(this.client));
    else if(['zoom_in','zoom_out','zoom_reset'].includes(action))this.zoom=parseZoom({zoom_in:'+',zoom_out:'-',zoom_reset:'reset'}[action],this.zoom);
    this.updateURL(this.context.url);this.changed();
  }
  // Existing Casty helpers expect send(); route their small subset directly to
  // the engine. There is no CDP socket or extra remote debugging server here.
  async send(method,p={}) {
    if(method==='Runtime.evaluate')return {result:{value:await this.context.evaluate(p.expression)}};
    if(method==='Input.dispatchMouseEvent'){if(p.type==='mouseReleased')await this.context.click(p.x,p.y);else if(p.type==='mouseMoved')await this.context.move(p.x,p.y);return {};}
    if(method==='Input.insertText'){await this.context.type(p.text);return {};}
    if(method==='Page.getFrameTree'){const r=this.context.resourceContent(this.context.url);return {frameTree:{frame:{id:'main',url:this.context.url,mimeType:r?.contentType||''}}};}
    if(method==='Page.getResourceContent'){const r=this.context.resourceContent(p.url);if(!r)throw Error('Page source unavailable');return {content:Buffer.from(r.body).toString('base64'),base64Encoded:true};}
    throw Error(`Unsupported frontend helper method: ${method}`);
  }
  paragraph(text,color) {
    const key=color+'\n'+text;let p=this.cache.get(key);if(p)return p;
    const {CanvasKit:k,fontCollection,monospaceFamily,fontFamilies}=this.graphics;
    const builder=k.ParagraphBuilder.MakeFromFontCollection(new k.ParagraphStyle({textStyle:{color:k.parseColorString(color),fontSize:16,fontFamilies:[monospaceFamily,...fontFamilies]},maxLines:1}),fontCollection);
    builder.addText(text);p=builder.build();builder.delete();p.layout(100000);
    if(this.cache.size>=256){const first=this.cache.keys().next().value;this.cache.get(first).delete();this.cache.delete(first);}
    this.cache.set(key,p);return p;
  }
  pixels(width) {
    if(width!==this.width){this.width=width;this.dirty=true;this.editor.columns=Math.max(1,Math.floor(width/this.cellWidth));}
    if(!this.dirty&&this.bytes)return this.bytes;
    const {CanvasKit:k}=this.graphics;if(!this.surface||this.surface.width()!==width){this.surface?.delete();this.surface=k.MakeSurface(width,this.height);}
    const canvas=this.surface.getCanvas(),paint=new k.Paint();
    canvas.clear(k.parseColorString(this.editor.editing?'#005f87':'#303030'));
    const cols=this.editor.columns;
    const ansi=this.editor.editing?this.editor._editLine(cols):this.editor._displayLine(cols);
    let inverse=false,x=0;
    for(const part of ansi.split(/(\x1b\[[\d;]*m)/)) {
      if(part.startsWith('\x1b')){if(part==='\x1b[7m')inverse=true;else if(part==='\x1b[27m')inverse=false;continue;}
      for(const char of part){const w=displayWidth(char)*this.cellWidth;
        if(inverse){paint.setColor(k.parseColorString('#f4f8ff'));canvas.drawRect(k.XYWHRect(x,0,w,this.height),paint);}
        if(char.trim()){const p=this.paragraph(char,inverse?'#005f87':'#f4f8ff');canvas.drawParagraph(p,x,(this.height-p.getHeight())/2);}
        x+=w;if(x>=width)break;
      }
    }
    if(this.editor.editing&&!this.editor.selectionRange&&this.caret){const view=this.editor._editView(cols);paint.setColor(k.parseColorString('#72e0e8'));canvas.drawRect(k.XYWHRect(view.cursorCol*this.cellWidth,6,1,20),paint);}
    paint.delete();this.surface.flush();const image=this.surface.makeImageSnapshot();
    try{this.bytes=Buffer.from(image.readPixels(0,0,{width,height:this.height,colorType:k.ColorType.RGBA_8888,alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB}));}finally{image.delete();}
    // Only the small toolbar strip is converted; page BGRA bytes remain untouched.
    for(let i=0;i<this.bytes.length;i+=4){const red=this.bytes[i];this.bytes[i]=this.bytes[i+2];this.bytes[i+2]=red;}
    this.dirty=false;return this.bytes;
  }
  dispose(){clearInterval(this.timer);clearTimeout(this.statusTimer);clearInterval(this.editor._spinTimer);this.editor.cancelEditing();for(const p of this.cache.values())p.delete();this.cache.clear();this.surface?.delete();}
}

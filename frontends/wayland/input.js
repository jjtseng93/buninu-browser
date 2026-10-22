import {readSync} from 'node:fs';
import {libc} from './transport.js';

// A deliberately bounded XKB subset, not a replacement for libxkbcommon.
export function parseKeymap(text) {
  const codes=new Map(),keys=new Map();
  for(const m of text.matchAll(/<([^>]+)>\s*=\s*(\d+)/g))codes.set(m[1],Number(m[2])-8);
  for(const m of text.matchAll(/key\s+<([^>]+)>\s*\{[^}]*\[([^\]]+)\]/g)){
    const code=codes.get(m[1]);if(code!==undefined)keys.set(code,m[2].split(',').map(s=>s.trim()));
  }return keys;
}
const names={space:' ',Return:'Enter',KP_Enter:'Enter',Tab:'Tab',ISO_Left_Tab:'Tab',Escape:'Escape',BackSpace:'Backspace',Delete:'Delete',Insert:'Insert',Home:'Home',End:'End',Prior:'PageUp',Next:'PageDown',Left:'ArrowLeft',Right:'ArrowRight',Up:'ArrowUp',Down:'ArrowDown',slash:'/',period:'.',comma:',',minus:'-',equal:'=',semicolon:';',apostrophe:"'",bracketleft:'[',bracketright:']',backslash:'\\',grave:'`'};
export function keysym(symbol){
  if(names[symbol]!==undefined)return names[symbol];if(!symbol)return null;
  if(symbol.length===1||/^F\d+$/.test(symbol))return symbol;
  if(/^(?:0x[\da-f]+|U[\da-f]+)$/i.test(symbol)){let n=parseInt(symbol.replace(/^U/i,''),16);if(n>=0xffbe&&n<=0xffe0)return 'F'+(n-0xffbd);const special={65288:'Backspace',65289:'Tab',65293:'Enter',65307:'Escape',65535:'Delete',65360:'Home',65361:'ArrowLeft',65362:'ArrowUp',65363:'ArrowRight',65364:'ArrowDown',65365:'PageUp',65366:'PageDown',65367:'End',65379:'Insert'};if(special[n])return special[n];if(n>=0xff00&&n<0x1000000)return null;if(n>=0x1000000)n-=0x1000000;return n>0&&n<=0x10ffff?String.fromCodePoint(n):null;}
  return null;
}
export function attachInput(client,window,context,onError) {
  if(!client.globals.has('wl_seat'))return;
  let pointer,keyboard,x=0,y=0,focused=false,keys=new Map(),mods=0,locked=0;
  const active=()=>!window.closed&&!client.connection.closed;
  const invoke=(method,...args)=>{
    if(!active())return;
    // A compositor can send leave/modifier events in the same batch as close.
    // Pending input is cancelled with the renderer; it must not restart/report it.
    Promise.resolve().then(()=>active()?context[method](...args):undefined)
      .catch(error=>{if(active())onError(error);});
  };
  const seat=client.bind('wl_seat',5,(event,[caps])=>{
    if(event!=='capabilities')return;
    if((caps&1)&&!pointer){pointer=client.object('wl_pointer',(name,args)=>{
      if(name==='enter'){focused=args[1]===window.surface;[x,y]=args.slice(2);}
      if(name==='leave')focused=false;
      if(name==='motion'){[x,y]=args.slice(1);if(focused)invoke('move',x,y);}
      if(name==='button'&&focused&&args[2]===272&&args[3]===0)invoke('click',x,y);
      if(name==='axis'&&focused)invoke('scroll',args[1]===1?args[2]:0,args[1]===0?args[2]:0,{x,y});
    });client.request(seat,'get_pointer',pointer);}
    if((caps&2)&&!keyboard){keyboard=client.object('wl_keyboard',(name,args)=>{
      if(name==='keymap'){const [format,fd,size]=args;try{if(format===1&&size<=1024*1024){const bytes=Buffer.alloc(size);let n=0;while(n<size){const got=readSync(fd,bytes,n,size-n,n);if(!got)break;n+=got;}keys=parseKeymap(bytes.subarray(0,n).toString());}}finally{libc.close(fd);}}
      if(name==='modifiers'){mods=args[1]|args[2];locked=args[3];}
      if(name==='key'&&args[3]===1){const symbols=keys.get(args[2]);if(!symbols)return;let shift=!!(mods&1);if((locked&2)&&/^[a-z]$/.test(keysym(symbols[0])||''))shift=!shift;
        const key=keysym(symbols[shift?1:0]||symbols[0]);if(key)invoke('press',key,{modifiers:(mods&8?1:0)|(mods&4?2:0)|(mods&64?4:0)|(mods&1?8:0)});
      }
    });client.request(seat,'get_keyboard',keyboard);}
  });
}

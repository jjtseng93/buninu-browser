import {readSync} from './resource-io.js';
import {libc} from './transport.js';

// A deliberately bounded XKB subset, not a replacement for libxkbcommon.
export function parseKeymap(text) {
  const codes=new Map(),keys=new Map();
  for(const m of text.matchAll(/<([^>]+)>\s*=\s*(\d+)/g))codes.set(m[1],Number(m[2])-8);
  for(const m of text.matchAll(/key\s+<([^>]+)>\s*\{([^}]+)\}/g)){
    const list=/\[([^\]]+)\]/.exec(m[2]),code=codes.get(m[1]);
    if(code!==undefined&&list){const symbols=list[1].split(',').map(s=>s.trim());symbols.repeat=!/\brepeat\s*=\s*(?:no|false)\b/i.test(m[2]);keys.set(code,symbols);}
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
  let lastClick=null, clickCount=0;
  let keyboardFocused=false,repeatRate=25,repeatDelay=600,repeatKey=null,repeatTimer,disposed=false;
  const stopRepeat=()=>{clearTimeout(repeatTimer);repeatTimer=null;repeatKey=null;};
  const modifiers=()=>({modifiers:(mods&8?1:0)|(mods&4?2:0)|(mods&64?4:0)|(mods&1?8:0)});
  const active=()=>!disposed&&!window.closed&&!client.connection.closed;
  const invoke=(method,...args)=>{
    if(!active())return;
    // A compositor can send leave/modifier events in the same batch as close.
    // Pending input is cancelled with the renderer; it must not restart/report it.
    return Promise.resolve().then(()=>active()?context[method](...args):undefined)
      .catch(error=>{if(active())onError(error);});
  };
  const pressKey=(code,repeat=false)=>{
    const symbols=keys.get(code);if(!symbols)return;
    let shift=!!(mods&1);
    if((locked&2)&&/^[a-z]$/.test(keysym(symbols[0])||''))shift=!shift;
    const key=keysym(symbols[shift?1:0]||symbols[0]);
    if(key)return invoke('press',key,{...modifiers(),...(repeat?{repeat:true}:{})});
  };
  const startRepeat=code=>{
    const symbols=keys.get(code);
    // Modifier-only keys must not cancel an arrow's ongoing repeat.
    if(!symbols?.some(symbol=>keysym(symbol)))return;
    stopRepeat();if(!repeatRate||!keyboardFocused||symbols.repeat===false)return;
    const token={code};repeatKey=token;
    const tick=async()=>{
      if(repeatKey!==token||!active()||!keyboardFocused){if(repeatKey===token)stopRepeat();return;}
      // Wait for the previous press; slow renderers must not accumulate repeats.
      await pressKey(code,true);
      if(repeatKey===token&&active()&&keyboardFocused)
        repeatTimer=setTimeout(tick,Math.max(1,1000/repeatRate));
    };
    repeatTimer=setTimeout(tick,repeatDelay);
  };
  const seat=client.bind('wl_seat',5,(event,[caps])=>{
    if(event!=='capabilities')return;
    if(!(caps&2)){keyboardFocused=false;stopRepeat();}
    if((caps&1)&&!pointer){pointer=client.object('wl_pointer',(name,args)=>{
      if(name==='enter'){focused=args[1]===window.surface;[x,y]=args.slice(2);}
      if(name==='leave'){focused=false;lastClick=null;clickCount=0;}
      if(name==='motion'){[x,y]=args.slice(1);if(focused)invoke('move',x,y,modifiers());}

      // Mouse-triggered copy also has a valid Wayland input serial.
      if(name==='button'&&focused&&client.clipboard)client.clipboard.serial=args[0];

      if(name==='button'&&focused){
        const [,time,button,state]=args;
        if(state){
          // Wayland supplies monotonic uint32 milliseconds, not a click count.
          // Allow modest touch jitter in surface coordinates; reset on leave.
          clickCount=lastClick&&lastClick.button===button&&((time-lastClick.time)>>>0)<400
            &&Math.abs(x-lastClick.x)<=12&&Math.abs(y-lastClick.y)<=12 ? clickCount+1 : 1;
          lastClick={time,button,x,y};
        }
        const options={clickCount:clickCount||1,...modifiers()};
        if(context.pointerButton)invoke('pointerButton',x,y,button,state,options);
        else if(state===0&&button>=272&&button<=274)invoke('click',x,y,{...options,button:button===273?'right':button===274?'middle':'left'});
      }
      if(name==='axis'&&focused){
        // Browser scrolling consumes pixel deltas. Land maps 100 CDP pixels
        // to 10 Wayland axis units; restore that scale on the client side.
        // Preserve fractional movement and apply page zoom later in the toolbar.
        const delta=args[2]*10;
        invoke('scroll',args[1]===1?delta:0,args[1]===0?delta:0,{x,y});
      }
    });client.request(seat,'get_pointer',pointer);}
    if((caps&2)&&!keyboard){keyboard=client.object('wl_keyboard',(name,args)=>{

      // Use the compositor's real keyboard serial for selection.
      if(name==='enter'||name==='key')if(client.clipboard)client.clipboard.serial=args[0];

      if(name==='keymap'){stopRepeat();const [format,fd,size]=args;try{if(format===1&&size<=1024*1024){const bytes=Buffer.alloc(size);let n=0;while(n<size){const got=readSync(fd,bytes,n,size-n,n);if(!got)break;n+=got;}keys=parseKeymap(bytes.subarray(0,n).toString());}}finally{libc.close(fd);}}
      if(name==='enter'){keyboardFocused=args[1]===window.surface;stopRepeat();}
      if(name==='leave'){keyboardFocused=false;stopRepeat();}
      if(name==='repeat_info'){
        repeatRate=Math.max(0,args[0]);repeatDelay=Math.max(0,args[1]);
        const code=repeatKey?.code;stopRepeat();if(code!==undefined)startRepeat(code);
      }
      if(name==='modifiers'){mods=args[1]|args[2];locked=args[3];}
      if(name==='key'){
        if(args[3]===0){if(repeatKey?.code===args[2])stopRepeat();}
        else if(args[3]===1&&keyboardFocused){pressKey(args[2]);startRepeat(args[2]);}
      }
    });client.request(seat,'get_keyboard',keyboard);}
  });
  return ()=>{disposed=true;stopRepeat();};
}

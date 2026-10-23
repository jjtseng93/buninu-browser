// Shared editing defaults for HTML and QML's real input/textarea elements.
export function isTextInput(element) {
  return !!element && !element.disabled && (element.tagName==='TEXTAREA' ||
    element.tagName==='INPUT' && ['text','search','url','email','tel','password'].includes(element.type));
}
export const inputRange = element => ({text:String(element.value),start:element.selectionStart??0,end:element.selectionEnd??0});
export function selectInput(element,start,end=start) {
  element.setSelectionRange(Math.min(start,end),Math.max(start,end),end<start?'backward':'forward');
}
const columns=new WeakMap();
export function moveInputSelection(element,event) {
  if(!isTextInput(element)||event.altKey)return false;
  const {text,start,end}=inputRange(element),ctrl=event.ctrlKey||event.metaKey,key=event.key;
  if(ctrl&&key.toLowerCase()==='a'){selectInput(element,0,text.length);return true;}
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(key))return false;
  let at=element.selectionDirection==='backward'?start:end;
  const anchor=at===start?end:start,multi=element.tagName==='TEXTAREA';
  const lineStart=text.lastIndexOf('\n',at-1)+1;
  if(key==='ArrowUp'||key==='ArrowDown') {
    if(!multi)return false;
    const previous=columns.get(element),column=previous?.at===at?previous.column:at-lineStart;
    if(key==='ArrowUp') {
      const stop=lineStart-1;at=stop<0?0:Math.min(text.lastIndexOf('\n',stop-1)+1+column,stop);
    } else {
      const next=text.indexOf('\n',at),stop=next<0?-1:text.indexOf('\n',next+1);
      at=next<0?text.length:Math.min(next+1+column,stop<0?text.length:stop);
    }
    columns.set(element,{at,column});
  } else {
    columns.delete(element);
    if(key==='Home')at=multi&&!ctrl?lineStart:0;
    else if(key==='End'){const stop=text.indexOf('\n',at);at=multi&&!ctrl&&stop>=0?stop:text.length;}
    else if(!event.shiftKey&&start!==end)at=key==='ArrowLeft'?start:end;
    else if(key==='ArrowLeft') {
      at-=[...text.slice(0,at)].pop()?.length??0;
      if(ctrl){while(at>0&&/\s/u.test(text[at]))at--;while(at>0&&/[\p{L}\p{N}_]/u.test(text[at-1]))at--;}
    } else {
      at+=text.codePointAt(at)>0xffff?2:at<text.length?1:0;
      if(ctrl){while(at<text.length&&/[\p{L}\p{N}_]/u.test(text[at]))at++;while(at<text.length&&/\s/u.test(text[at]))at++;}
    }
  }
  selectInput(element,event.shiftKey?anchor:at,at);return true;
}
export async function inputClipboard(element,operation,{read,write,replace}) {
  if(!isTextInput(element)||operation!=='copy'&&element.readOnly)return;
  const range=inputRange(element);
  if(operation==='copy'||operation==='cut') {
    if(element.type==='password'||range.start===range.end)return;
    await write(range.text.slice(range.start,range.end));
    if(operation==='copy')return;
  }
  let text=operation==='paste'?await read():'';
  if(String(element.value)!==range.text||element.selectionStart!==range.start||element.selectionEnd!==range.end||element.readOnly||!element.isConnected)return;
  if(element.tagName!=='TEXTAREA')text=text.replace(/[\r\n]+/g,'');
  if(element.maxLength>=0)text=text.slice(0,Math.max(0,element.maxLength-(range.text.length-range.end+range.start)));
  replace(text,operation==='paste'?'insertFromPaste':'deleteByCut');
}

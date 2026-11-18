import HTMLParser from '../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts';

// Keep the tree builder alive between writes. Submit complete tokens so a
// split tag, character reference, or script body never becomes literal text.
export function documentStream(window, document, scriptReady, point=null, stillCurrent=()=>true) {
  const parser=new HTMLParser(window);
  const root=point ? document.createDocumentFragment() : document;
  parser.parse('',root);
  let pending='';
  let blocked=null;
  let ended=false;
  function drain() {
    while(pending && stillCurrent()){
      let end=pending.indexOf('<');
      let script=false;
      if(end===0){
        const start=/^<(\/?)([a-z][^\t\n\f\r />]*)/i.exec(pending);
        if(pending.startsWith('<!--')){
          const close=/--!?>/.exec(pending.slice(4));
          end=close ? 4+close.index+close[0].length : -1;
        }else{
          const tag=/^<(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(pending);
          end=tag?.[0].length ?? -1;
          if(end>0 && start && !start[1] && /^(script|style|textarea|title)$/i.test(start[2])){
            const close=new RegExp('</'+start[2]+'[\\t\\n\\f\\r ]*>','i').exec(pending.slice(end));
            end=close ? end+close.index+close[0].length : -1;
            script=Boolean(close) && start[2].toLowerCase()==='script';
          }
        }
        if(end<0){if(!ended)return;end=pending.length;}
      }else if(end<0){
        const tail=!ended && /&(?:#x?[0-9a-f]*|[a-z0-9]*)$/i.exec(pending);
        end=tail ? tail.index : pending.length;
        if(!end)return;
      }
      const chunk=pending.slice(0,end);
      pending=pending.slice(end);
      parser.appendMarkup(chunk);
      if(point && root.firstChild)point.parent.insertBefore(root,point.next?.parentNode===point.parent ? point.next : null);
      if(script && parser.nextElement?.localName==='script'){
        const loading=scriptReady(parser.nextElement);
        if(loading){
          const resume=()=>{blocked=null;return drain();};
          blocked=loading.then(resume,resume);
          return blocked;
        }
      }
    }
  }
  return {
    write(text){pending+=text;if(!blocked)drain();},
    close(){ended=true;return blocked ?? drain();},
  };
}

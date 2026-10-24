// QML Shortcut adapter over the existing DOM keyboard events.
export function createQmlShortcuts(api) {
  const entries = new Set();
  const names = {escape:'Escape',esc:'Escape',space:'Space',tab:'Tab',backtab:'Backtab',return:'Return',enter:'Enter',left:'Left',right:'Right',up:'Up',down:'Down',home:'Home',end:'End',pgup:'PgUp',pageup:'PgUp',pgdown:'PgDown',pagedown:'PgDown',delete:'Del',del:'Del',insert:'Ins',ins:'Ins',backspace:'Backspace'};
  const keyName = key => names[String(key).toLowerCase()] || (/^f(?:[1-9]|[12]\d|3[0-5])$/i.test(key) ? key.toUpperCase() : [...String(key)].length===1 ? String(key).toUpperCase() : '');
  function parse(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const strokes = value.trim()===',' ? [','] : value.split(/,\s*/);
    if (strokes.length>4) return [];
    const result=[];
    for(const stroke of strokes){
      let rest=stroke.trim(), mods=[];
      while(/^(ctrl|alt|shift|meta)\+/i.test(rest)){
        const at=rest.indexOf('+');mods.push(rest.slice(0,at).toLowerCase());rest=rest.slice(at+1);
      }
      const key=keyName(rest);if(!key)return [];
      result.push({key,mods:new Set(mods)});
    }
    return result;
  }
  const text = value => parse(value).map(({key,mods})=>['ctrl','alt','shift','meta'].filter(m=>mods.has(m)).map(m=>m[0].toUpperCase()+m.slice(1)).concat(key).join('+')).join(', ');
  function matches(stroke,event){
    const key=event.key===' ' ? 'Space' : event.key==='Enter' ? 'Return' : event.key?.replace(/^Arrow/,'');
    if(stroke.key!==keyName(key) && !(stroke.key==='Enter' && key==='Return'))return false;
    for(const name of ['ctrl','alt','meta'])if(stroke.mods.has(name)!==!!event[name+'Key'])return false;
    // Shift is intrinsic to printable punctuation such as '+' and '?'.
    if(stroke.mods.has('shift')!==!!event.shiftKey && !(event.shiftKey && !stroke.mods.has('shift') && key?.length===1 && !/[a-z0-9]/i.test(key)))return false;
    return true;
  }
  function keydown(event){
    if(event.defaultPrevented || event.isComposing)return;
    const complete=[], partial=[];
    for(const entry of entries){
      const v=entry.v, window=v.Window?.window;
      if(!v.enabled || (!v.autoRepeat && event.repeat) || (window && (window.visible===false || (v.context!==2 && api.activeWindow() && api.activeWindow()!==window)))){entry.pending=[];continue;}
      const sequences=(v.sequences?.length?v.sequences:[v.sequence]).map(parse).filter(s=>s.length);
      const candidates=entry.pending.length && Date.now()-entry.time<1000 ? entry.pending : sequences.map(s=>({s,at:0}));
      entry.pending=[];
      for(const candidate of candidates){
        if(!matches(candidate.s[candidate.at],event))continue;
        if(candidate.at+1===candidate.s.length)complete.push(entry);
        else entry.pending.push({s:candidate.s,at:candidate.at+1});
      }
      if(entry.pending.length){entry.time=Date.now();partial.push(entry);}
    }
    if(!complete.length&&!partial.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    const unique=[...new Set(complete)];
    if(unique.length){
      for(const entry of entries)entry.pending=[];
      for(const entry of unique)api.emit(entry.v, unique.length>1||partial.length ? 'onActivatedAmbiguously':'onActivated');
    }
  }
  function make(v,type){
    if(type!=='Shortcut')return;
    Object.assign(v,{sequence:'',sequences:[],autoRepeat:true,context:1});
    Object.defineProperty(v,'portableText',{get:()=>text(v.sequences?.length?v.sequences[0]:v.sequence)});
    Object.defineProperty(v,'nativeText',{get:()=>v.portableText});
    const entry={v,pending:[],time:0};
    if(!entries.size)document.addEventListener('keydown',keydown,true);
    entries.add(entry);
    api.cleanup(()=>{entries.delete(entry);if(!entries.size)document.removeEventListener('keydown',keydown,true);});
  }
  return {make};
}

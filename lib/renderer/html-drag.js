// Text drag data stays in the binding realm; never expose Happy DOM objects.
const stores = new WeakMap();
const transfers = new WeakMap();
const normalize = type => ({text:'text/plain',url:'text/uri-list'}[String(type).toLowerCase()] ?? String(type).toLowerCase());
export class DataTransfer {
  constructor() { stores.set(this, {mode:'readwrite', data:new Map(), drop:'none', effect:'uninitialized'}); }
  get types() { return Object.freeze([...stores.get(this).data.keys()]); }
  get files() { return Object.freeze([]); }
  getData(type) { const s=stores.get(this); return ['readwrite','readonly'].includes(s.mode) ? s.data.get(normalize(type)) ?? '' : ''; }
  setData(type, value) { const s=stores.get(this); if(s.mode==='readwrite')s.data.set(normalize(type),String(value)); }
  clearData(type) { const s=stores.get(this); if(s.mode==='readwrite'){if(type===undefined)s.data.clear();else s.data.delete(normalize(type));} }
  get dropEffect(){return stores.get(this).drop;}
  set dropEffect(value){if(['none','copy','link','move'].includes(value))stores.get(this).drop=value;}
  get effectAllowed(){return stores.get(this).effect;}
  set effectAllowed(value){const s=stores.get(this);if(s.mode==='readwrite'&&['none','copy','copyLink','copyMove','link','linkMove','move','all','uninitialized'].includes(value))s.effect=value;}
}
export function dragData(event){return transfers.get(event);}
export function dragEvent(window,type,init,data){
  const event=new window.MouseEvent(type,init);
  transfers.set(event,data);
  return event;
}
export function setDragMode(data,mode){stores.get(data).mode=mode;}

/** Pointer-driven HTML text drag lifecycle, separate from canvas mouse drawing. */
export class HTMLDrag {
  constructor(window,realm,source,x,y){
    Object.assign(this,{window,realm,source,x,y,startX:x,startY:y,active:false,target:null,accepted:false});
    this.data=new DataTransfer();
    const url=source.tagName==='A'?source.href:source.tagName==='IMG'?source.src:null;
    if(url){this.data.setData('text/uri-list',url);this.data.setData('text/plain',url);}
  }
  emit(target,type,x,y,options={}){
    const modifiers=options.modifiers??0;
    return this.realm.dispatch(target,dragEvent(this.window,type,{bubbles:true,cancelable:type!=='dragleave'&&type!=='dragend',
      clientX:x,clientY:y,button:0,buttons:type==='dragend'||type==='drop'?0:1,
      altKey:!!(modifiers&1),ctrlKey:!!(modifiers&2),metaKey:!!(modifiers&4),shiftKey:!!(modifiers&8)},this.data));
  }
  move(target,x,y,options){
    this.x=x;this.y=y;
    if(this.cancelled)return false;
    if(!this.active){
      if(Math.hypot(x-this.startX,y-this.startY)<5)return false;
      const cancelled=this.emit(this.source,'dragstart',this.startX,this.startY,options);
      setDragMode(this.data,'protected');
      if(cancelled||!this.source.isConnected){this.cancelled=true;setDragMode(this.data,'disabled');return false;}
      this.active=true;
      this.realm.dispatch(this.source,new this.window.PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse',isPrimary:true}));
    }
    this.emit(this.source,'drag',x,y,options);
    if(target!==this.target){
      if(target)this.emit(target,'dragenter',x,y,options);
      if(this.target)this.emit(this.target,'dragleave',x,y,options);
      this.target=target;
    }
    const allowed={none:[],copy:['copy'],link:['link'],move:['move'],copyLink:['copy','link'],copyMove:['copy','move'],linkMove:['link','move'],all:['copy','link','move'],uninitialized:['copy','link','move']}[this.data.effectAllowed];
    this.data.dropEffect=allowed[0]??'none';
    this.accepted=!!target&&this.emit(target,'dragover',x,y,options);
    this.accepted=this.accepted&&allowed.includes(this.data.dropEffect);
    if(!this.accepted)this.data.dropEffect='none';
    return true;
  }
  end(x=this.x,y=this.y,options={},cancel=false){
    if(!this.active){setDragMode(this.data,'disabled');return false;}
    if(!cancel&&this.accepted&&this.target?.isConnected){setDragMode(this.data,'readonly');this.emit(this.target,'drop',x,y,options);}
    else {this.data.dropEffect='none';if(this.target)this.emit(this.target,'dragleave',x,y,options);}
    setDragMode(this.data,'protected');
    this.emit(this.source,'dragend',x,y,options);
    setDragMode(this.data,'disabled');this.active=false;return true;
  }
}

export function isDraggable(element){
  const value=element?.getAttribute?.('draggable')?.toLowerCase();
  if(value==='true'||value==='false')return value==='true';
  return element?.tagName==='IMG'||element?.tagName==='A'&&element.hasAttribute('href');
}

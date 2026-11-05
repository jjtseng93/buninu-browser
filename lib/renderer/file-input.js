import { actuallyDisabled } from '../happy-dom/form-disabled.js';
// Selected files are capabilities granted by the browser UI, never host paths.
const selections=new WeakMap();
export function inputFiles(node){
 if(node?.tagName!=='INPUT'||node.type!=='file')return null;
 let list=selections.get(node);
 // The DOM owns reset/value="" semantics. Do not keep a stale selection after
 // it replaces its FileList (including form.reset()).
 if(!list||list!==node.files){list=Object.freeze(Object.assign(Array.from(node.files??[]), {item(index){return this[index]??null;}}));node.files=list;selections.set(node,list);}
 return list;
}
export async function chooseInputFiles(node,pick,window){
 if(node?.tagName!=='INPUT'||node.type!=='file'||actuallyDisabled(node)||!pick)return;
 const result=await pick({multiple:node.hasAttribute('multiple'),accept:node.getAttribute('accept')??''});
 if(!result?.accept){node.dispatchEvent(new window.Event('cancel',{bubbles:true}));return;}
 const files=(result.files??[]).map(f=>new File([Uint8Array.fromBase64(f.data)],f.name,{type:f.type,lastModified:f.lastModified}));
 if(!node.hasAttribute('multiple'))files.splice(1);
 const list=Object.freeze(Object.assign(files,{item(index){return this[index]??null;}}));
 selections.set(node,list);
 node.files=list;
 node.dispatchEvent(new window.Event('input',{bubbles:true,composed:true}));
 node.dispatchEvent(new window.Event('change',{bubbles:true}));
}
export function fileReaderInterface({EventTarget,realm,window,runTask,
 createProgressEvent=(type,init)=>realm.wrapEvent(new window.ProgressEvent(type,init))}){
 class FileReader extends EventTarget {
  #serial=0; #result=null; #error=null; #state=0;
  get result(){return this.#result;}get error(){return this.#error;}get readyState(){return this.#state;}
  #emit(type,operation){
   const init={lengthComputable:!!operation,loaded:operation?.loaded??0,total:operation?.total??0};
   runTask(()=>this.dispatchEvent(createProgressEvent(type,init)));
  }
  #read(blob,kind,encoding){
   if(!(blob instanceof Blob))throw new TypeError('Expected a Blob');
   if(this.#state===1)throw new DOMException('A read is already in progress','InvalidStateError');
   const operation={serial:++this.#serial,loaded:0,total:blob.size};
   this.#state=1;this.#result=null;this.#error=null;
   setTimeout(async()=>{
    if(operation.serial!==this.#serial)return;
    this.#emit('loadstart',operation);
    // A synchronous event handler can abort this read and start another one.
    if(operation.serial!==this.#serial)return;
    try {
     const bytes=new Uint8Array(await blob.arrayBuffer());
     if(operation.serial!==this.#serial)return;
     operation.loaded=bytes.byteLength;
     // Progress describes the pending read. Its result stays null and its
     // readyState stays LOADING until immediately before load/error.
     if(bytes.byteLength)this.#emit('progress',operation);
     if(operation.serial!==this.#serial)return;
     this.#state=2;
     this.#result=kind==='array'?bytes.buffer:kind==='data'?`data:${blob.type||'application/octet-stream'};base64,${bytes.toBase64()}`:kind==='binary'?Array.from(bytes,b=>String.fromCharCode(b)).join(''):new TextDecoder(encoding).decode(bytes);
     this.#emit('load',operation);
    }catch(e){
     // A late rejection from an aborted read must not complete its successor.
     if(operation.serial!==this.#serial)return;
     this.#error=new DOMException(String(e),'NotReadableError');this.#state=2;this.#emit('error',operation);
    }
    // File API checks state after dispatch: load/error may begin a new read.
    if(this.#state!==1)this.#emit('loadend',operation);
   },0);
  }
  readAsDataURL(blob){this.#read(blob,'data');}readAsText(blob,encoding='utf-8'){this.#read(blob,'text',encoding);}
  readAsArrayBuffer(blob){this.#read(blob,'array');}readAsBinaryString(blob){this.#read(blob,'binary');}
  abort(){
   this.#result=null;
   if(this.#state!==1)return;
   ++this.#serial;this.#state=2;
   this.#emit('abort',null);
   if(this.#state!==1)this.#emit('loadend',null);
  }
 }
 for(const [k,v] of Object.entries({EMPTY:0,LOADING:1,DONE:2})){Object.defineProperty(FileReader,k,{value:v});Object.defineProperty(FileReader.prototype,k,{value:v});}
 for(const type of ['loadstart','progress','load','error','abort','loadend']){
  const handlers=new WeakMap();Object.defineProperty(FileReader.prototype,'on'+type,{configurable:true,enumerable:true,get(){return handlers.get(this)??null;},set(fn){const old=handlers.get(this);if(old)this.removeEventListener(type,old);if(typeof fn==='function'){handlers.set(this,fn);this.addEventListener(type,fn);}else handlers.delete(this);}});
 }
 return FileReader;
}

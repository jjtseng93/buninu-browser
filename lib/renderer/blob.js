import {encodingString} from './encoding-string.js';

const NativeBlob=globalThis.Blob, NativeFile=globalThis.File;
const nativeSize=Object.getOwnPropertyDescriptor(NativeBlob.prototype,'size').get;
const nativeType=Object.getOwnPropertyDescriptor(NativeBlob.prototype,'type').get;
const nativeName=Object.getOwnPropertyDescriptor(NativeFile.prototype,'name').get;
const nativeSlice=NativeBlob.prototype.slice;
const nativeMethods=Object.fromEntries(['arrayBuffer','bytes','text','stream'].map(name=>[name,NativeBlob.prototype[name]]));
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const bufferResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable').get;
const typedBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'buffer').get;
const dataBuffer=Object.getOwnPropertyDescriptor(DataView.prototype,'buffer').get;
const isView=ArrayBuffer.isView, wellFormed=String.prototype.toWellFormed;
const NativeTypeError=globalThis.TypeError;
const nativeResolve=Promise.resolve,nativeReject=Promise.reject;
const exposed=new WeakSet();
const object=value=>value!==null&&(typeof value==='object'||typeof value==='function');
export const isNativeBlob=value=>{try{nativeSize.call(value);return true;}catch{return false;}};
const hasFileMetadata=value=>{try{return typeof nativeName.call(value)==='string';}catch{return false;}};

// Bun checks its MIME table before lowercasing. Its table promotes several
// plain types to a UTF-8 charset, which File API constructors must not add.
// Validated uppercase ASCII takes the literal-string branch, then Bun stores
// the exact required lowercase type in its real native slot (also for fetch).
export function nativeBlobType(type) {
  return /[^\x20-\x7e]/.test(type)?'':type.toUpperCase();
}

export function createNativeBlob(parts,type='') {
  // Bun's single-Blob shortcut also duplicates File name/lastModified slots.
  // A second empty part takes its ordinary Blob path and clears that File
  // identity, so FormData and structured clone see an ordinary Blob again.
  if(parts.length===1&&hasFileMetadata(parts[0]))parts=[parts[0],''];
  return new NativeBlob(parts,{type:nativeBlobType(type)});
}

export function createNativeFile(parts,name,options={}) {
  return new NativeFile(parts,name,{...options,type:nativeBlobType(options.type??'')});
}

export function blobNumber(value,error) {
  if(object(value)) {
    const exotic=value[Symbol.toPrimitive];
    if(exotic!=null){if(typeof exotic!=='function')throw error('TypeError','Invalid primitive converter');value=Reflect.apply(exotic,value,['number']);}
    else {const original=value;for(const key of ['valueOf','toString']){const method=original[key];if(typeof method==='function'){value=Reflect.apply(method,original,[]);if(!object(value))break;}}}
  }
  if(object(value)||typeof value==='symbol'||typeof value==='bigint')throw error('TypeError','Expected a number');
  return Number(value);
}

export function blobParts(parts,error) {
  if(!object(parts))throw error('TypeError','Blob parts must be a sequence');
  const method=parts[Symbol.iterator];if(typeof method!=='function')throw error('TypeError','Blob parts must be iterable');
  const source=Reflect.apply(method,parts,[]);
  if(!object(source))throw error('TypeError','Iterator must return an object');
  const next=source.next;if(typeof next!=='function')throw error('TypeError','Iterator next must be callable');
  const converted=[];
  while(true) {
    const item=Reflect.apply(next,source,[]);
    if(!object(item))throw error('TypeError','Iterator result must be an object');
    if(item.done)break;
    const part=item.value;
    let buffer=false;try{bufferLength.call(part);buffer=true;}catch{}
    const view=isView(part);
    if(buffer||view) {
      let backing=part;
      if(view){try{backing=typedBuffer.call(part);}catch{backing=dataBuffer.call(part);}}
      // BufferSource has neither AllowShared nor AllowResizable here.
      // Native slots avoid consulting author-shadowed buffer properties.
      let resizable;try{resizable=bufferResizable.call(backing);}catch{throw error('TypeError','Shared buffers are not allowed');}
      if(resizable)throw error('TypeError','Resizable buffers are not allowed');
    }
    // A bare SharedArrayBuffer is not a BlobPart BufferSource: current Web IDL
    // union conversion falls through to USVString (shared-backed views throw).
    // Web IDL sequence conversion propagates failures without IteratorClose.
    converted.push(isNativeBlob(part)||buffer||view?part:wellFormed.call(encodingString(part,error)));
  }
  return converted;
}

// Convert each USVString separately: CR at the end of one part and LF at the
// beginning of the next are two line endings, not one CRLF pair.
export function blobEndings(parts,endings) {
  if(endings!=='native')return parts;
  const newline=process.platform==='win32'?'\r\n':'\n';
  return parts.map(part=>typeof part==='string'?part.replace(/\r\n|\r|\n/g,newline):part);
}

export function blobInterface({global=()=>globalThis}={}) {
  let intrinsics;
  const error=(_name,message)=>new (intrinsics?.TypeError??global().TypeError)(message);
  const brand=value=>{try{return nativeSize.call(value);}catch{throw error('TypeError','Illegal invocation');}};
  const Blob=new Proxy(function Blob(){throw error('TypeError','Blob requires new');},{construct(_target,args,newTarget){
    const parts=args[0]===undefined?[]:blobParts(args[0],error),options=args[1];
    if(options!=null&&!object(options))throw error('TypeError','Blob options must be a dictionary');
    const rawEndings=options?.endings;
    const endings=rawEndings===undefined?'transparent':encodingString(rawEndings,error);
    if(endings!=='transparent'&&endings!=='native')throw error('TypeError','Invalid Blob endings');
    const rawType=options?.type,type=rawType===undefined?'':encodingString(rawType,error);
    const requested=newTarget.prototype,prototype=object(requested)?requested:Blob.prototype;
    let value;
    try{value=createNativeBlob(blobEndings(parts,endings),type);}
    catch(caught){if(caught instanceof NativeTypeError)throw error('TypeError',caught.message);throw caught;}
    Object.setPrototypeOf(value,prototype);exposed.add(value);return value;
  }});
  Object.defineProperties(Blob.prototype,{
    constructor:{value:Blob,writable:true,configurable:true},
    size:{get(){return brand(this);},configurable:true,enumerable:true},
    type:{get(){brand(this);return nativeType.call(this);},configurable:true,enumerable:true},
    slice:{value:({slice(start=undefined,end=undefined,contentType=undefined){
      const size=brand(this);
      const clamp=value=>{
        const n=blobNumber(value,error);if(Number.isNaN(n))return 0;
        const bounded=Math.max(-Number.MAX_SAFE_INTEGER,Math.min(Number.MAX_SAFE_INTEGER,n));
        const floor=Math.floor(bounded),fraction=bounded-floor;
        return fraction<.5?floor:fraction>.5?floor+1:floor%2===0?floor:floor+1;
      };
      start=start===undefined?0:clamp(start);end=end===undefined?size:clamp(end);
      const type=contentType===undefined?'':encodingString(contentType,error);
      start=start<0?Math.max(size+start,0):Math.min(start,size);
      end=end<0?Math.max(size+end,0):Math.min(end,size);
      const bytes=nativeSlice.call(this,start,Math.max(start,end),'');
      // Rewrap the native slice backing to clear Bun's static MIME fallback
      // when the caller omitted contentType. No JS byte-buffer copy is needed.
      return expose(createNativeBlob([bytes],type));
    }}).slice,writable:true,configurable:true,enumerable:true},
    [Symbol.toStringTag]:{value:'Blob',configurable:true},
  });
  for(const [name,method] of Object.entries(nativeMethods)) {
    const value=({[name](){
      const Promise=intrinsics?.Promise??global().Promise;
      try{brand(this);const result=Reflect.apply(method,this,[]);return name==='stream'?result:Reflect.apply(nativeResolve,Promise,[result]);}
      catch(caught){if(name==='stream')throw caught;return Reflect.apply(nativeReject,Promise,[caught]);}
    }})[name];
    Object.defineProperty(Blob.prototype,name,{value,writable:true,configurable:true,enumerable:true});
  }
  Object.defineProperty(Blob,'prototype',{writable:false});
  function expose(value) {
    brand(value);
    if(!exposed.has(value)){
      // Body.blob() can also carry Bun's source File metadata. Its API result
      // is always a Blob; retain any distinct parsed response MIME override.
      if(hasFileMetadata(value)){
        const type=Object.getOwnPropertyDescriptor(value,'type');
        value=createNativeBlob([value],nativeType.call(value));
        if(type)Object.defineProperty(value,'type',type);
      }
      Object.setPrototypeOf(value,Blob.prototype);exposed.add(value);
    }
    return value;
  }
  function exposeClonedData(value,exposeFile) {
    // Only walk native structured-clone results, never author objects. Keep
    // their native data, sharing, cycles and transferables; change Blob/File
    // prototypes at the receiving boundary without cloning a second time.
    const pending=[value],seen=new WeakSet();
    while(pending.length){
      const item=pending.pop();if(!object(item)||seen.has(item))continue;seen.add(item);
      if(isNativeBlob(item)){
        if(hasFileMetadata(item))exposeFile(item);else expose(item);
      } else if(item instanceof Map){
        Map.prototype.forEach.call(item,(entry,key)=>{pending.push(key,entry);});
      } else if(item instanceof Set){
        Set.prototype.forEach.call(item,entry=>pending.push(entry));
      } else if(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null){
        for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(item)))if('value' in descriptor)pending.push(descriptor.value);
      }
    }
    return value;
  }
  return {Blob,expose,exposeClonedData,initialize(value){intrinsics={TypeError:value.TypeError,Promise:value.Promise};Object.setPrototypeOf(Blob.prototype,value.Object?.prototype??Object.prototype);}};
}

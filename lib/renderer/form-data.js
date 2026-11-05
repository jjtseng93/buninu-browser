import NativeEvent from '../../vendor/happy-dom/packages/happy-dom/src/event/Event.ts';
import {markEventTrusted} from '../happy-dom/event-state.js';
import {constructFormEntries} from '../happy-dom/form-data-entries.js';
import {formOwner} from '../happy-dom/radio-groups.js';
import {encodingString} from './encoding-string.js';
import {blobInterface,blobParts,blobNumber,blobEndings,createNativeFile} from './blob.js';

const NativeFormData=globalThis.FormData, NativeFile=globalThis.File, NativeBlob=globalThis.Blob;
const native=Object.fromEntries(['append','set','delete','entries'].map(name=>[name,NativeFormData.prototype[name]]));
const blobType=Object.getOwnPropertyDescriptor(NativeBlob.prototype,'type').get;
const blobSize=Object.getOwnPropertyDescriptor(NativeBlob.prototype,'size').get;
const fileName=Object.getOwnPropertyDescriptor(NativeFile.prototype,'name').get;
const modified=Object.getOwnPropertyDescriptor(NativeFile.prototype,'lastModified').get;
const wellFormed=String.prototype.toWellFormed;
const NativeTypeError=globalThis.TypeError;
const dataStates=new WeakMap(), eventData=new WeakMap(), iterators=new WeakMap(), exposedFiles=new WeakSet();
const html='http://www.w3.org/1999/xhtml';
const object=value=>value!==null&&(typeof value==='object'||typeof value==='function');
const isBlob=value=>{try{blobSize.call(value);return true;}catch{return false;}};
const isFile=value=>{try{return typeof fileName.call(value)==='string';}catch{return false;}};
class NativeFormDataEvent extends NativeEvent {}
Object.defineProperty(NativeFormDataEvent,'name',{value:'FormDataEvent'});

// The private list preserves Web IDL/File identity, while native FormData
// slots are updated by every mutation. Fetch/Request/Response can thus consume
// real BodyInit without consulting an author-overridden iterator or getter.
export function formDataInterface({unwrap=()=>null, realm=null, global=()=>globalThis, blobs=blobInterface({global})}={}) {
  let intrinsics;
  const globals=()=>intrinsics??global();
  const error=(name,message)=>name==='TypeError'?new (globals().TypeError)(message):new (globals().DOMException)(message,name);
  const string=value=>wellFormed.call(encodingString(value,error));
  const stateOf=self=>{const state=dataStates.get(self);if(!state)throw error('TypeError','Illegal invocation');return state;};
  const array=values=>new (globals().Array)(...values);
  function exposeFile(file) {
    if(!exposedFiles.has(file)){Object.setPrototypeOf(file,File.prototype);exposedFiles.add(file);}
    return file;
  }
  const File=new Proxy(function File(parts,name){throw error('TypeError','File requires new');},{construct(_target,args,newTarget){return createFile(args,newTarget);}});
  function createFile(args,newTarget) {
    let [parts,name,options={}]=args;
    if(args.length<2)throw error('TypeError','File requires two arguments');
    const converted=blobParts(parts,error);
    name=string(name);
    if(options!=null&&!object(options))throw error('TypeError','File options must be a dictionary');
    const endingsValue=options?.endings;
    const endings=endingsValue===undefined?'transparent':encodingString(endingsValue,error);
    if(endings!=='transparent'&&endings!=='native')throw error('TypeError','Invalid File endings');
    const lastModified=options?.lastModified;
    let stamp;
    if(lastModified!==undefined){const n=blobNumber(lastModified,error);stamp=Number.isFinite(n)?Number(BigInt.asIntN(64,BigInt(Math.trunc(n)))):0;}
    const typeValue=options?.type;
    const type=typeValue===undefined?'':encodingString(typeValue,error);
    // Resolve author-controlled newTarget.prototype outside the native catch.
    const requested=newTarget.prototype,prototype=object(requested)?requested:File.prototype;
    let file;
    try{file=createNativeFile(blobEndings(converted,endings),name,{type,...(stamp===undefined?{}:{lastModified:stamp})});}
    catch(caught){if(caught instanceof NativeTypeError)throw error('TypeError',caught.message);throw caught;}
    Object.setPrototypeOf(file,prototype);exposedFiles.add(file);return file;
  }
  Object.defineProperty(File.prototype,'constructor',{value:File,writable:true,configurable:true});
  Object.setPrototypeOf(File,blobs.Blob);
  Object.setPrototypeOf(File.prototype,blobs.Blob.prototype);
  Object.defineProperties(File.prototype,{name:{get(){if(!isFile(this))throw error('TypeError','Illegal invocation');return fileName.call(this);},configurable:true,enumerable:true},lastModified:{get(){if(!isFile(this))throw error('TypeError','Illegal invocation');return modified.call(this);},configurable:true,enumerable:true},[Symbol.toStringTag]:{value:'File',configurable:true}});
  Object.defineProperty(File,'prototype',{writable:false});
  function fromEntries(entries, newTarget=FormData) {
    const requested=newTarget.prototype;
    const self=new NativeFormData();Object.setPrototypeOf(self,object(requested)?requested:FormData.prototype);
    const state={entries:[]};dataStates.set(self,state);
    for(let [name,value] of entries){if(isFile(value))value=exposeFile(value);native.append.call(self,name,value);state.entries.push([name,value]);}
    return self;
  }
  function entry(name,value,filename,count) {
    name=string(name);
    if(count>=3&&!isBlob(value))throw error('TypeError','The value must be a Blob when a filename is provided');
    if(!isBlob(value))return [name,string(value)];
    const file=isFile(value);
    if(filename!==undefined)filename=string(filename);
    if(!file||filename!==undefined)value=new File([value],filename??'blob',{
      type:blobType.call(value),...(file?{lastModified:modified.call(value)}:{}),
    });
    return [name,exposeFile(value)];
  }
  function collect(form,submitter=null) {
    return constructFormEntries(form,submitter,{File,dispatch(entries){
      const data=fromEntries(entries),event=new NativeFormDataEvent('formdata',{bubbles:true});
      eventData.set(event,data);markEventTrusted(event);form.dispatchEvent(event);
      return stateOf(data).entries.map(pair=>pair.slice());
    }});
  }
  const FormData=new Proxy(function FormData(){throw error('TypeError','FormData requires new');},{construct(_target,args,newTarget){return createData(args,newTarget);}});
  function createData(args,newTarget) {
    const [form=undefined,submitter=null]=args;
    let node=null,button=null;
    if(form!==undefined){node=unwrap(form);if(node?.namespaceURI!==html||node.localName!=='form')throw error('TypeError','Expected an HTMLFormElement');}
    if(submitter!=null){button=unwrap(submitter);if(button?.namespaceURI!==html)throw error('TypeError','Expected an HTMLElement');}
    let entries=[];
    if(node){
      if(button){
        if(!((button.localName==='button'&&button.type==='submit')||(button.localName==='input'&&['submit','image'].includes(button.type))))throw error('TypeError','The submitter must be a submit button');
        if(formOwner(button)!==node)throw error('NotFoundError','The submitter is not owned by this form');
      }
      entries=collect(node,button);
      if(entries===null)throw error('InvalidStateError','The form entry list is already being constructed');
    }
    return fromEntries(entries,newTarget);
  }
  Object.defineProperty(FormData.prototype,'constructor',{value:FormData,writable:true,configurable:true});
  Object.defineProperty(FormData,'prototype',{writable:false});
  const methods={
    append(name,value,filename=undefined){
      const state=stateOf(this);if(arguments.length<2)throw error('TypeError','append requires two arguments');
      const pair=entry(name,value,filename,arguments.length);native.append.call(this,...pair);state.entries.push(pair);
    },
    set(name,value,filename=undefined){
      const state=stateOf(this);if(arguments.length<2)throw error('TypeError','set requires two arguments');
      const pair=entry(name,value,filename,arguments.length);native.set.call(this,...pair);
      let found=false;const entries=[];for(const current of state.entries){if(current[0]!==pair[0])entries.push(current);else if(!found){entries.push(pair);found=true;}}
      if(!found)entries.push(pair);state.entries=entries;
    },
    delete(name){const state=stateOf(this);if(!arguments.length)throw error('TypeError','delete requires a name');name=string(name);native.delete.call(this,name);state.entries=state.entries.filter(pair=>pair[0]!==name);},
    get(name){const state=stateOf(this);if(!arguments.length)throw error('TypeError','get requires a name');name=string(name);return state.entries.find(pair=>pair[0]===name)?.[1]??null;},
    getAll(name){const state=stateOf(this);if(!arguments.length)throw error('TypeError','getAll requires a name');name=string(name);return array(state.entries.filter(pair=>pair[0]===name).map(pair=>pair[1]));},
    has(name){const state=stateOf(this);if(!arguments.length)throw error('TypeError','has requires a name');name=string(name);return state.entries.some(pair=>pair[0]===name);},
    forEach(callback,thisArg=undefined){const state=stateOf(this);if(typeof callback!=='function')throw error('TypeError','Callback must be callable');for(let i=0;i<state.entries.length;i++){const [name,value]=state.entries[i];Reflect.apply(callback,thisArg,[value,name,this]);}},
    entries(){return iterator(stateOf(this),'entries');},
    keys(){return iterator(stateOf(this),'keys');},
    values(){return iterator(stateOf(this),'values');},
  };
  for(const [name,value] of Object.entries(methods))Object.defineProperty(FormData.prototype,name,{value,writable:true,configurable:true,enumerable:true});
  Object.defineProperties(FormData.prototype,{[Symbol.iterator]:{value:methods.entries,writable:true,configurable:true},[Symbol.toStringTag]:{value:'FormData',configurable:true}});
  const iteratorPrototype={
    next(){const state=iterators.get(this);if(!state)throw error('TypeError','Illegal invocation');const pair=state.data?.entries[state.index++];if(!pair)state.data=null;
      const value=!pair?undefined:state.kind==='keys'?pair[0]:state.kind==='values'?pair[1]:array(pair);
      const result=new (globals().Object)();Object.defineProperties(result,{value:{value,writable:true,enumerable:true,configurable:true},done:{value:!pair,writable:true,enumerable:true,configurable:true}});return result;},
    [Symbol.iterator](){return this;},
  };
  Object.defineProperty(iteratorPrototype,Symbol.toStringTag,{value:'FormData Iterator',configurable:true});
  function iterator(data,kind){const result=Object.create(iteratorPrototype);iterators.set(result,{data,kind,index:0});return result;}
  const FormDataEvent=new Proxy(function FormDataEvent(type,init){throw error('TypeError','FormDataEvent requires new');},{construct(_target,args,newTarget){return createEvent(args,newTarget);}});
  function createEvent(args,newTarget){
    let [type,init]=args;
    if(args.length<2)throw error('TypeError','FormDataEvent requires two arguments');
    type=encodingString(type,error);
    if(init!=null&&!object(init))throw error('TypeError','Expected an event dictionary');
    const bubbles=Boolean(init?.bubbles),cancelable=Boolean(init?.cancelable),composed=Boolean(init?.composed),data=init?.formData;
    if(!dataStates.has(data))throw error('TypeError','formData must be a FormData');
    const event=new NativeFormDataEvent(type,{bubbles,cancelable,composed});eventData.set(event,data);
    const wrapper=realm.wrapEvent(event);const prototype=newTarget.prototype;
    if(object(prototype))Object.setPrototypeOf(wrapper,prototype);return wrapper;
  }
  if(realm){
    Object.defineProperty(FormDataEvent.prototype,'constructor',{value:FormDataEvent,writable:true,configurable:true});
    Object.setPrototypeOf(FormDataEvent.prototype,realm.eventPrototype);
    Object.defineProperty(FormDataEvent.prototype,'formData',{get(){const event=realm.unwrapEvent(this);if(!eventData.has(event))throw error('TypeError','Illegal invocation');return eventData.get(event);},enumerable:true,configurable:true});
    Object.defineProperty(FormDataEvent.prototype,Symbol.toStringTag,{value:'FormDataEvent',configurable:true});
    Object.defineProperty(FormDataEvent,'prototype',{writable:false});realm.eventPrototypes.set('FormDataEvent',FormDataEvent.prototype);
  }
  return {FormData,FormDataEvent,File,exposeFile,collect,
    initialize(value){blobs.initialize(value);intrinsics={TypeError:value.TypeError,DOMException:value.DOMException,Array:value.Array,Object:value.Object};},
    fromNative(value){const entries=[];for(const [name,entry] of native.entries.call(value))entries.push([name,isBlob(entry)?new File([entry],fileName.call(entry),{type:blobType.call(entry),lastModified:modified.call(entry)}):entry]);return fromEntries(entries);},
  };
}

export function formFileName(file){return fileName.call(file);}

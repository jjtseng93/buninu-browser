// Windows-only named pagefile mappings. No DLL is loaded on other platforms.
import {dlopen,toArrayBuffer} from 'bun:ffi';
import {fstatSync,readSync,writeSync,closeSync} from 'node:fs';
if(process.platform!=='win32')throw Error('Named mappings require Windows');
const sig=(args,returns)=>({args,returns});
const {symbols:k}=dlopen('kernel32.dll',{
 CreateFileMappingW:sig(['i64','ptr','u32','u32','u32','ptr'],'ptr'),
 OpenFileMappingW:sig(['u32','i32','ptr'],'ptr'),
 MapViewOfFile:sig(['ptr','u32','u32','u32','u64'],'ptr'),
 UnmapViewOfFile:sig(['ptr'],'i32'),CloseHandle:sig(['ptr'],'i32'),GetLastError:sig([],'u32'),
});
const entries=new Map();let next=-1;
const MAX=256*1024*1024;
const wide=s=>Buffer.from(s+'\0','utf16le');
const fail=what=>Error(`${what}: Win32 error ${k.GetLastError()}`);
function mapped(name,size,kind,create){
 if(!/^Local\\buninu-wayland-[\da-f-]{36}$/.test(name)||!Number.isInteger(size)||size<1||size>MAX)throw Error('Invalid named mapping');
 const handle=create?k.CreateFileMappingW(-1n,null,4,0,size,wide(name)):k.OpenFileMappingW(0xf001f,0,wide(name));
 if(!handle)throw fail('File mapping');
 if(create&&k.GetLastError()===183){k.CloseHandle(handle);throw Error('Mapping name collision')}
 const address=k.MapViewOfFile(handle,0xf001f,0,0,size);
 if(!address){const e=fail('MapViewOfFile');k.CloseHandle(handle);throw e}
 return {name,size,kind,handle,address,bytes:Buffer.from(toArrayBuffer(address,0,size)),refs:0,forwarded:false};
}
function add(entry,writer=false){entry.refs++;const fd=next--;entries.set(fd,{entry,writer});return fd}
export function createMapping(size,kind='pixels'){
 const e=mapped('Local\\buninu-wayland-'+crypto.randomUUID(),size,kind,true);return add(e,kind==='pipe');
}
export function closeResource(fd){
 if(fd>=0){closeSync(fd);return 0}
 const item=entries.get(fd);if(!item)return 0;entries.delete(fd);
 const e=item.entry;
 if(item.writer&&!item.forwarded)Atomics.store(new Int32Array(e.bytes.buffer,e.bytes.byteOffset,2),1,1);
 if(--e.refs===0){k.UnmapViewOfFile(e.address);k.CloseHandle(e.handle);e.bytes=null}
 return 0;
}
export function sendResource(fd){
 let item=entries.get(fd),temporary;
 if(!item){const size=fstatSync(fd).size;if(size>MAX)throw Error('Resource exceeds limit');const data=Buffer.alloc(size);let at=0;while(at<size){const n=readSync(fd,data,at,size-at,at);if(!n)throw Error('Short resource file');at+=n}temporary=createMapping(Math.max(1,data.length),'bytes');item=entries.get(temporary);data.copy(item.entry.bytes)}
 const retained=add(item.entry,false);
 if(item.writer)item.forwarded=true;
 const descriptor={name:item.entry.name,size:item.entry.size,kind:item.entry.kind,writer:item.writer};
 if(temporary!==undefined)closeResource(temporary);
 return {descriptor,release:()=>closeResource(retained)};
}
export function receiveResource(d){
 if(!d||!['pixels','bytes','pipe'].includes(d.kind)||typeof d.writer!=='boolean'||(d.writer&&d.kind!=='pipe')||(d.kind==='pipe'&&d.size<9))throw Error('Invalid resource descriptor');
 return add(mapped(d.name,d.size,d.kind,false),d.writer);
}
export function readResource(fd,buffer,offset=0,length=buffer.length-offset,position=null){
 if(fd>=0)return readSync(fd,buffer,offset,length,position);
 const item=entries.get(fd);if(!item)throw Error('Closed mapping');const e=item.entry;
 if(e.kind==='pipe'){
  const header=new Int32Array(e.bytes.buffer,e.bytes.byteOffset,2),available=Atomics.load(header,0),start=item.position??0;
  if(available<start||available>e.size-8)throw Error('Invalid pipe length');
  const n=Math.min(length,available-start);
  if(!n&&!Atomics.load(header,1))throw Object.assign(Error('Pipe pending'),{code:'EAGAIN'});
  e.bytes.copy(buffer,offset,8+start,8+start+n);item.position=start+n;return n;
 }
 const start=position??item.position??0,n=Math.max(0,Math.min(length,e.size-start));
 e.bytes.copy(buffer,offset,start,start+n);if(position===null)item.position=start+n;return n;
}
export function writeResource(fd,buffer,offset=0,length=buffer.length-offset,position=null){
 if(fd>=0)return writeSync(fd,buffer,offset,length,position);
 const item=entries.get(fd);if(!item)throw Error('Closed mapping');const e=item.entry;
 const start=e.kind==='pipe'?Atomics.load(new Int32Array(e.bytes.buffer,e.bytes.byteOffset,2),0):(position??item.position??0),header=e.kind==='pipe'?8:0;
 if(start+length>e.size-header)throw Error('Mapping write exceeds capacity');
 e.bytes.set(buffer.subarray(offset,offset+length),header+start);
 if(header)Atomics.store(new Int32Array(e.bytes.buffer,e.bytes.byteOffset,2),0,start+length);else if(position===null)item.position=start+length;
 return length;
}
let lastErrno=0;
export const libc={
 close:closeResource,createMapping,fcntl:()=>0,
 pipe2(out){const fd=createMapping(1024*1024+8,'pipe'),e=entries.get(fd).entry;out[0]=add(e);out[1]=fd;return 0},
 pread(fd,b,n,p){try{return readResource(fd,b,0,n,Number(p))}catch{lastErrno=5;return -1}},
 read(fd,b,n){try{return readResource(fd,b,0,n)}catch(e){lastErrno=e.code==='EAGAIN'?11:5;return -1}},
 write(fd,b,n){try{return writeResource(fd,b,0,n)}catch{lastErrno=5;return -1}},
};
export const errno=()=>lastErrno;

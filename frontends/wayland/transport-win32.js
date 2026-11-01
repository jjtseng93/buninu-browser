import * as resources from './win32-resources.js';
import {MappingConnection} from './win32-wire.js';
export const {libc,errno}=resources;
export const Connection=MappingConnection;
export function connectUnix(path){
 const c=new MappingConnection(resources);
 Bun.connect({unix:path,socket:{open:s=>c.attach(s),data:(_,b)=>c.receive(b),drain:()=>c.flush(),close:()=>c.close(),error:(_,e)=>{c.error=e;c.close()}}}).catch(e=>{c.error=e;c.close()});
 return c;
}

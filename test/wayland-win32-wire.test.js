import {test,expect} from 'bun:test';
import {existsSync} from 'node:fs';
const sibling=existsSync(new URL('../../buninu-land/lib/win32-wire.js',import.meta.url));
import {MappingConnection} from '../frontends/wayland/win32-wire.js';
import {encodeRequest,decode,interfaces} from '../frontends/wayland/protocol.js';
function resources(){
 const objects=new Map(),fds=new Map();let serial=0;
 const put=o=>{const fd=++serial;fds.set(fd,o);o.refs++;return fd};
 const api={
  create(bytes){const o={name:crypto.randomUUID(),bytes,refs:0};objects.set(o.name,o);return put(o)},
  sendResource(fd){const o=fds.get(fd);if(!o)throw Error('closed');o.refs++;let released=false;
   return {descriptor:{name:o.name},release(){if(released)throw Error('double release');released=true;o.refs--}}},
  receiveResource(d){const o=objects.get(d.name);if(!o||!o.refs)throw Error('mapping gone');return put(o)},
  closeResource(fd){const o=fds.get(fd);if(o){o.refs--;fds.delete(fd)}},
  get:fd=>fds.get(fd),objects,
 };return api;
}
function pair(r,partial=false){
 const a=new MappingConnection(r),b=new MappingConnection(r),toA=[],toB=[];
 const socket=queue=>({write(bytes){const n=partial?Math.min(7,bytes.length):bytes.length;queue.push(Buffer.from(bytes.subarray(0,n)));return n},end(){}});
 a.attach(socket(toB));b.attach(socket(toA));
 const pump=()=>{for(let i=0;i<1000;i++){
  a.flush();b.flush();while(toA.length)a.receive(toA.shift());while(toB.length)b.receive(toB.shift());
  if(!a.output.length&&!b.output.length&&!toA.length&&!toB.length)return;
 }throw Error('pump did not drain')};
 return {a,b,pump};
}
test('mapping envelope preserves Wayland FD order, fragmented bytes, ACK lifetime and live pixels',()=>{
 const r=resources(),{a,b,pump}=pair(r,true),pixels=Buffer.from([1,2,3,4]),fd=r.create(pixels),o=r.get(fd);
 const request=encodeRequest(4,'wl_shm','create_pool',[8,fd,4]);a.send(request.data,request.fds);r.closeResource(fd);
 expect(o.refs).toBe(1);expect(a.pending.size).toBe(1);pump();
 expect(a.pending.size).toBe(0);expect(o.refs).toBe(1);
 const args=decode(interfaces.get('wl_shm').requests[0],b.input,b.fds);
 expect(args.slice(0,1)).toEqual([8]);expect(args[2]).toBe(4);
 expect(r.get(args[1]).bytes).toBe(pixels);pixels[0]=99;expect(r.get(args[1]).bytes[0]).toBe(99);
 r.closeResource(args[1]);a.close();b.close();expect(o.refs).toBe(0);
});
test('disconnect releases unacknowledged mapping handles and queued descriptors',()=>{
 const r=resources(),{a,b}=pair(r),fd=r.create(Buffer.alloc(4)),o=r.get(fd);
 a.send(Buffer.alloc(8),[fd]);r.closeResource(fd);expect(o.refs).toBe(1);a.close();b.close();expect(o.refs).toBe(0);
});
test('malformed envelope and unsolicited ACK close the connection',()=>{
 const r=resources(),{a,b,pump}=pair(r);
 a.packet({version:1,ack:123});pump();expect(b.closed).toBe(true);expect(b.error.message).toContain('ACK');a.close();
 const c=new MappingConnection(r),header=Buffer.alloc(8);header.writeUInt32LE(2*1024*1024);c.receive(header);expect(c.closed).toBe(true);
});
test.skipIf(process.platform==='win32')('non-Windows mapping modules reject before any DLL call',async()=>{
 for(const path of ['../frontends/wayland/win32-resources.js',...(sibling?['../../buninu-land/lib/win32-resources.js']:[])]){
  try{await import(path);throw Error('unexpected import success')}catch(e){expect(e.message).toBe('Named mappings require Windows')}
 }
 const browser=await import('../frontends/wayland/transport.js'),posix=await import('../frontends/wayland/transport-posix.js');
 expect(browser.libc).toBe(posix.libc);
});
test.skipIf(!sibling)('both projects use identical Windows resource and framing implementations',async()=>{
 for(const file of ['win32-resources.js','win32-wire.js']){
  const a=await Bun.file(new URL('../frontends/wayland/'+file,import.meta.url)).text();
  const b=await Bun.file(new URL('../../buninu-land/lib/'+file,import.meta.url)).text();expect(a).toBe(b);
 }
});

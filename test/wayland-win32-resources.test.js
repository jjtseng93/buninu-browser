import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const windows=process.platform==='win32';
test.skipIf(!windows)('Windows mapping shares pixels between independent Bun processes',async()=>{
 const r=await import('../frontends/wayland/win32-resources.js');
 const fd=r.createMapping(16),held=r.sendResource(fd);
 let child;
 try{
  expect(held.descriptor.name).toMatch(/^Local\\buninu-wayland-/);
  r.writeResource(fd,Buffer.from([1,2,3,4]),0,4,0);
  const module=new URL('../frontends/wayland/win32-resources.js',import.meta.url).href;
  child=Bun.spawn([process.execPath,'-e',`
   const r=await import(${JSON.stringify(module)}),fd=r.receiveResource(JSON.parse(Bun.argv.at(-1)));
   try{const b=Buffer.alloc(4);r.readResource(fd,b,0,4,0);if(b[0]!==1)throw Error('wrong pixels');
    r.writeResource(fd,Buffer.from([9,8,7,6]),0,4,0);
   }finally{r.closeResource(fd)}
  `,JSON.stringify(held.descriptor)],{stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),15000);
  try{const error=await new Response(child.stderr).text();expect({code:await child.exited,error}).toEqual({code:0,error:''})}finally{clearTimeout(timer)}
  const b=Buffer.alloc(4);r.readResource(fd,b,0,4,0);expect([...b]).toEqual([9,8,7,6]);
 }finally{child?.kill();held.release();r.closeResource(fd)}
},20000);
test.skipIf(!windows)('Windows pipe resource preserves pending reads and EOF across FD transfer',async()=>{
 const r=await import('../frontends/wayland/win32-resources.js'),fds=new Int32Array(2);r.libc.pipe2(fds);
 const held=r.sendResource(fds[1]);r.closeResource(fds[1]);const remote=r.receiveResource(held.descriptor);held.release();
 try{
  const b=Buffer.alloc(32);expect(()=>r.readResource(fds[0],b)).toThrow('pending');
  r.writeResource(remote,Buffer.from('中文 clipboard'));r.closeResource(remote);
  const n=r.readResource(fds[0],b);expect(b.subarray(0,n).toString()).toBe('中文 clipboard');expect(r.readResource(fds[0],b)).toBe(0);
 }finally{r.closeResource(remote);r.closeResource(fds[0])}
});
test.skipIf(!windows)('Windows ordinary socket delivers a named mapping with resource ACK',async()=>{
 const r=await import('../frontends/wayland/win32-resources.js');
 const {MappingConnection}=await import('../frontends/wayland/win32-wire.js');
 const {connectUnix}=await import('../frontends/wayland/transport.js');
 const dir=mkdtempSync(join(tmpdir(),'wayland-mapping-')),path=join(dir,'wayland-buninu');
 let server,client,peer;const fd=r.createMapping(4);
 try{
  r.writeResource(fd,Buffer.from([12,34,56,78]),0,4,0);
  server=Bun.listen({unix:path,socket:{open(s){peer=new MappingConnection(r);s.data=peer;peer.attach(s);peer.onData=()=>{const b=Buffer.alloc(4);const received=peer.fds.shift();try{r.readResource(received,b)}finally{r.closeResource(received)}peer.send(b)}},data:(s,b)=>s.data.receive(b),drain:s=>s.data.flush(),close:s=>s.data.close()}});
  client=connectUnix(path);client.send(Buffer.from('commit'),[fd]);
  const deadline=Date.now()+5000;while(client.input.length<4&&Date.now()<deadline)await Bun.sleep(10);
  expect([...client.input]).toEqual([12,34,56,78]);expect(client.pending.size).toBe(0);
 }finally{client?.close();peer?.close();server?.stop(true);r.closeResource(fd);rmSync(dir,{recursive:true,force:true})}
});

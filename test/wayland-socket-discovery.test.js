import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {socketCandidates,discoverSocket} from '../frontends/wayland/socket-discovery.js';
test('default names prefer Land, then traditional Wayland, in the selected runtime directory',()=>{
 expect(socketCandidates(undefined,{env:{},temp:'/temp'})).toEqual([join('/temp','wayland-buninu'),join('/temp','wayland-0')]);
 expect(socketCandidates(undefined,{env:{XDG_RUNTIME_DIR:'/xdg',TMPDIR:'/tmp'},temp:'/temp'})).toEqual([join('/xdg','wayland-buninu'),join('/xdg','wayland-0')]);
 expect(socketCandidates(undefined,{env:{TMPDIR:'/tmp'},temp:'/temp'})[0]).toBe(join('/tmp','wayland-buninu'));
});
test('explicit socket and WAYLAND_DISPLAY are authoritative',()=>{
 expect(socketCandidates('/explicit',{env:{WAYLAND_DISPLAY:'custom'}})).toEqual(['/explicit']);
 expect(socketCandidates(undefined,{env:{XDG_RUNTIME_DIR:'/xdg',WAYLAND_DISPLAY:'custom'}})).toEqual([join('/xdg','custom')]);
 expect(socketCandidates(undefined,{env:{XDG_RUNTIME_DIR:'/xdg',WAYLAND_DISPLAY:'/absolute/socket'}})).toEqual(['/absolute/socket']);
});
test('failed connection attempts fall back without relying on file existence',async()=>{
 const tried=[],good={close(){}};
 const result=await discoverSocket(path=>{tried.push(path);if(tried.length===1)throw Error('Connection refused');return good},undefined,{env:{},temp:'/temp'});
 expect(result).toBe(good);expect(tried).toHaveLength(2);expect(tried[1]).toBe(join('/temp','wayland-0'));
});
test('asynchronous Windows-style connection failure closes resources before fallback',async()=>{
 let closed=0,calls=0;const good={close(){}};
 expect(await discoverSocket(()=>++calls===1?{ready:Promise.reject(Error('missing')),close(){closed++}}:good,undefined,{env:{},temp:'/temp'})).toBe(good);
 expect(closed).toBe(1);
});
test('failure explains attempted paths, runtime directory and display exports',async()=>{
 const tried=[];let error;
 try{await discoverSocket(path=>{tried.push(path);throw Error('missing')},undefined,{env:{XDG_RUNTIME_DIR:'/runtime',WAYLAND_DISPLAY:'chosen'}})}catch(e){error=e}
 expect(tried).toEqual([join('/runtime','chosen')]);expect(error.message).toContain(join('/runtime','chosen'));
 expect(error.message).toContain('export XDG_RUNTIME_DIR=');expect(error.message).toContain('export WAYLAND_DISPLAY=');expect(error.message).toContain('explicitly set');
});

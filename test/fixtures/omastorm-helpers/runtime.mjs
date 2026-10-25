import {mkdtemp,rm,stat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
export async function startEngine() {
 const runtime=await mkdtemp('/tmp/omastorm-buninu-');
 const engine=process.env.OMASTORM_ENGINE_BINARY||'/usr/local/bin/omastorm-engine';
 const env={...process.env,XDG_RUNTIME_DIR:runtime,OMASTORM_ENGINE_BINARY:engine};
 let child;
 const close=async()=>{
  if(child && child.exitCode===null){
   child.kill('SIGTERM');
   const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},3000);
   try{await child.exited;}finally{clearTimeout(timer);}
  }
  await rm(runtime,{recursive:true,force:true});
 };
 try {
  child=Bun.spawn([engine,'serve'],{env,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
  const socket=runtime+'/omastorm/engine.sock';
  const deadline=Date.now()+15000;
  while(true){
   if(child.exitCode!==null)throw Error('Omastorm engine exited: '+child.exitCode);
   if(await stat(socket).then(s=>s.isSocket(),()=>false))break;
   if(Date.now()>deadline)throw Error('Omastorm engine socket did not become ready');
   await Bun.sleep(50);
  }
  return {env,socket,child,close};
 }catch(e){await close();throw e;}
}
export function waylandPath(env=process.env){
 const path=env.WAYLAND_DISPLAY||'/tmp/wayland-buninu';
 return isAbsolute(path)?path:resolve(env.XDG_RUNTIME_DIR||'/tmp',path);
}

import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WaylandUrlBar} from '../frontends/wayland/urlbar.js';
import {shellCommand} from '../frontends/wayland/casty/shell-command.js';
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await Bun.sleep(5);}throw Error('Shell state did not arrive');};
const running=pid=>{
 try{process.kill(pid,0);}catch{return false;}
 // A killed child may briefly await reaping by the host's PID 1.
 try{return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`,'utf8'));}catch{return process.platform!=='linux';}
};

test('shell cancellation before spawn rejects without executing the command',async()=>{
 const controller=new AbortController();controller.abort();
 await expect(shellCommand('echo should-not-run',{signal:controller.signal})).rejects.toThrow();
});

test.skipIf(process.platform==='win32')('disposing Wayland chrome kills a running shell and children without late status updates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wayland-shell-')),file=join(dir,'pids');
 let changes=0,pids=[];
 const bar=new WaylandUrlBar({},{history:{list:()=>[],add(){}},changed:()=>changes++});
 const command=bar.command(`sh sleep 30 & echo "$$ $!" > '${file}'; wait`);
 try{
  await until(()=>existsSync(file)&&readFileSync(file,'utf8').trim().split(/\s+/).length===2);
  pids=readFileSync(file,'utf8').trim().split(/\s+/).map(Number);
  expect(pids.every(running)).toBe(true);
  const status=bar.editor._status;
  bar.dispose();const disposedChanges=changes;
  await command;
  await until(()=>pids.every(pid=>!running(pid)));
  expect(bar.editor._status).toBe(status);
  expect(changes).toBe(disposedChanges);
  bar.dispose();
 }finally{
  bar.dispose();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}
  await command;rmSync(dir,{recursive:true,force:true});
 }
});

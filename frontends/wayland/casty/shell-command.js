import {existsSync} from 'node:fs';

export function findShell({exists=existsSync,which=name=>Bun.which(name)}={}) {
  if (exists('/bin/sh')) return {path:'/bin/sh',args:['-c']};
  for (const name of ['sh','bash','dash','zsh','ksh','ash','fish','pwsh','powershell','cmd.exe','cmd']) {
    const path=which(name);if(!path)continue;
    const shell=name.toLowerCase().replace(/\.exe$/,'');
    return {path,args:shell==='cmd'?['/d','/s','/c']:['pwsh','powershell'].includes(shell)?['-NoLogo','-NoProfile','-NonInteractive','-Command']:['-c']};
  }
  throw Error('No shell found');
}

export async function shellCommand(command,{signal}={}) {
  signal?.throwIfAborted();
  const shell=findShell();
  const child=Bun.spawn([shell.path,...shell.args,command],{stdin:'ignore',stdout:'pipe',stderr:'pipe',detached:process.platform!=='win32'});
  const parts=[],readers=new Set();let bytes=0,truncated=false,termination;
  const abort=()=>{
    if(termination)return;
    if(process.platform==='win32'){
      const taskkill=Bun.which('taskkill.exe');
      termination=(async()=>{
        // Terminate the shell's process tree as well as its pipe owners.
        if(taskkill)try{await Bun.spawn([taskkill,'/PID',String(child.pid),'/T','/F'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).exited;}catch{}
        try{child.kill('SIGKILL');}catch{}
      })();
    }else{
      // The command has its own process group, including shell children that
      // may still hold stdout open after the shell itself has exited.
      try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
      termination=Promise.resolve();
    }
    for(const reader of readers)void reader.cancel(signal?.reason).catch(()=>{});
  };
  async function drain(stream){
    const reader=stream.getReader(),decoder=new TextDecoder();readers.add(reader);
    try{
      while(!signal?.aborted){
        const {done,value:chunk}=await reader.read();if(done)break;
        const take=Math.min(chunk.length,Math.max(0,16384-bytes));bytes+=take;
        if(take)parts.push(decoder.decode(chunk.subarray(0,take),{stream:true}));
        if(take<chunk.length)truncated=true;
      }
      parts.push(decoder.decode());
    }finally{readers.delete(reader);reader.releaseLock();}
  }
  const drains=[drain(child.stdout),drain(child.stderr)];
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{
    const [code]=await Promise.all([child.exited,...drains]);
    signal?.throwIfAborted();
    const output=Bun.stripANSI(parts.join('')).replace(/[\x00-\x1f\x7f-\x9f]+/g,' ').replace(/\s+/g,' ').trim();
    return `${output||'(no output)'}${truncated?' …':''}${code?` [exit ${code}]`:''}`;
  }catch(error){
    abort();
    await Promise.allSettled([child.exited,...drains]);
    throw error;
  }finally{
    signal?.removeEventListener('abort',abort);
    await termination;
  }
}

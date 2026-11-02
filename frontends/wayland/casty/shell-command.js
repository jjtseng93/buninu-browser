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

export async function shellCommand(command) {
  const shell=findShell();
  const child=Bun.spawn([shell.path,...shell.args,command],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const parts=[];let bytes=0,truncated=false;
  async function drain(stream){const decoder=new TextDecoder();for await(const chunk of stream){const take=Math.min(chunk.length,Math.max(0,16384-bytes));bytes+=take;if(take)parts.push(decoder.decode(chunk.subarray(0,take),{stream:true}));if(take<chunk.length)truncated=true;}parts.push(decoder.decode());}
  const [code]=await Promise.all([child.exited,drain(child.stdout),drain(child.stderr)]);
  const output=Bun.stripANSI(parts.join('')).replace(/[\x00-\x1f\x7f-\x9f]+/g,' ').replace(/\s+/g,' ').trim();
  return `${output||'(no output)'}${truncated?' …':''}${code?` [exit ${code}]`:''}`;
}

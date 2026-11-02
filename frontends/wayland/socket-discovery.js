import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
export function socketCandidates(path,{env=process.env,temp=tmpdir()}={}){
 if(path!==undefined&&path!==null)return [path];
 const directory=env.XDG_RUNTIME_DIR||env.TMPDIR||temp;
 const displays=env.WAYLAND_DISPLAY?[env.WAYLAND_DISPLAY]:['wayland-buninu','wayland-0'];
 return displays.map(display=>isAbsolute(display)?display:join(directory,display));
}
export async function discoverSocket(connect,path,options={}){
 const failures=[];
 for(const candidate of socketCandidates(path,options)){
  let connection;
  try{
   connection=connect(candidate);
   await connection.ready;
   if(connection.closed)throw connection.error??Error('Connection closed');
   return connection;
  }catch(error){connection?.close();failures.push(`  ${candidate}: ${error.message}`)}
 }
 const env=options.env??process.env;
 throw Error(`Unable to connect to a Wayland compositor. Tried:\n${failures.join('\n')}\n`
  +`Set XDG_RUNTIME_DIR to the compositor's socket directory and WAYLAND_DISPLAY to its socket name.\n`
  +`Example: export XDG_RUNTIME_DIR=/path/to/runtime; export WAYLAND_DISPLAY=wayland-buninu\n`
  +(process.platform==='win32'?`PowerShell: $env:XDG_RUNTIME_DIR='C:\\path\\to\\runtime'; $env:WAYLAND_DISPLAY='wayland-buninu'\n`:'')
  +(env.WAYLAND_DISPLAY?'WAYLAND_DISPLAY was explicitly set; other socket names were not tried.':''));
}

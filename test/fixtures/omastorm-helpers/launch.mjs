import {pathToFileURL} from 'node:url';
import {stat} from 'node:fs/promises';
import {startEngine,waylandPath} from './runtime.mjs';
const socket=waylandPath();
if(!await stat(socket).then(s=>s.isSocket(),()=>false))throw Error('Start Land and bind its socket to '+socket);
const root=process.env.OMASTORM_ROOT||'/opt/omastorm';
const browser=process.env.BUNINU_BROWSER_ROOT||'/opt/buninu-browser';
let engine,app,stopping=false;
const stop=()=>{stopping=true;app?.close();};
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
try {
 engine=await startEngine();
 // Set before importing the renderer/QML host, which snapshots environment.
 Object.assign(process.env,engine.env,{WAYLAND_DISPLAY:socket,OMASTORM_ROOT:root});
 const {launch}=await import(pathToFileURL(browser+'/frontends/wayland/index.js').href);
 if(!stopping){
  app=await launch({url:pathToFileURL(root+'/ui/shell.qml').href,socket,width:960,height:680,chrome:false});
  if(stopping)app.close();
  await Promise.race([app.done,engine.child.exited.then(code=>{throw Error('Omastorm engine stopped: '+code);})]);
 }
}finally{
 app?.close();await engine?.close();
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.off(signal,stop);
}

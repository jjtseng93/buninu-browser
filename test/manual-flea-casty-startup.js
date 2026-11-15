// Observe actual Casty PNG page transmissions without polling page JavaScript.
// Run from native Termux. Timestamps are complete Kitty packets at the test peer,
// not a WebView paint/presentation acknowledgement. Inspect the saved images.
import {mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {KittyPeer, isCastyContentFrame, stopCasty} from './manual-casty-home-startup.js';

const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log('bun test/manual-flea-casty-startup.js [empty-output-directory]\nRecords the first 64 PNG page transmissions for 15 seconds, using three temporary folders.\nUses the real Casty configuration and an inline PNG Kitty peer at 1280x800.\nInspect frames.json and PNGs to identify when folder icons appear.');
  process.exit(0);
}
if(args.length>1||args.some(a=>a.startsWith('--')))throw Error('Unknown arguments; use --help');
const root=resolve(import.meta.dir,'..');
const out=resolve(args[0]||mkdtempSync(join(tmpdir(),'flea-casty-')));
mkdirSync(out,{recursive:true});
if(readdirSync(out).length)throw Error('Output directory must be empty: '+out);
const fixture=mkdtempSync(join(tmpdir(),'flea-casty-folders-'));
for(const name of ['startup-alpha','startup-beta','startup-gamma'])mkdirSync(join(fixture,name));
let proc,terminal,error,tail='';
const signals=new Map(['SIGINT','SIGTERM','SIGHUP'].map(name=>[name,()=>{error=Error('Interrupted by '+name);} ]));
for(const [name,handler] of signals)process.on(name,handler);
const frames=[];
const start=performance.now();
const peer=new KittyPeer({
  write:bytes=>terminal.write(bytes),
  frame(bytes,transport,placement){
    if(isCastyContentFrame(bytes,placement)&&frames.length<64)
      frames.push({ms:performance.now()-start,bytes,transport});
  },
});
try{
  proc=Bun.spawn([process.execPath,resolve(root,'../casty/index.js'),
    Bun.pathToFileURL(resolve(root,'../flea-qml/ui/boot/shell.qml')).href],{
    cwd:root,
    env:{...process.env,CASTY_BROWSER:join(root,'buninu-browser.js'),FLEA_PATH:fixture,
      BUNINU_LOG:join(out,'browser.log'),TERM:'xterm-256color',TMUX:''},
    terminal:{cols:160,rows:40,data(tty,bytes){
      terminal=tty;tail=(tail+Buffer.from(bytes).toString()).slice(-8000);
      try{peer.feed(bytes);}catch(e){error=e;}
    }},
  });
  while(performance.now()-start<15000){
    if(error)throw error;
    if(proc.exitCode!==null)throw Error('Casty exited: '+proc.exitCode);
    await Bun.sleep(100);
  }
  if(!frames.length)throw Error('No PNG page frames received; inspect terminal.log and Casty capture configuration');
}finally{
  await stopCasty(proc);
  for(const [name,handler] of signals)process.off(name,handler);
  rmSync(fixture,{recursive:true,force:true});
  await Bun.write(join(out,'terminal.log'),tail);
  const manifest=[];
  for(const [i,frame] of frames.entries()){
    const file=`frame-${i+1}.png`;
    await Bun.write(join(out,file),frame.bytes);
    manifest.push({file,ms:frame.ms,transport:frame.transport});
  }
  await Bun.write(join(out,'frames.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({out,frames:manifest}));
}

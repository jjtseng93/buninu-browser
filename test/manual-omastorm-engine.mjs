// Requires an already-running official engine; never starts or installs one.
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBrowser} from '../lib/headless-shell.js';
const root=resolve(process.argv[2] || '../omastorm');
const dir=await mkdtemp('/tmp/omastorm-engine-probe-');
await Bun.write(dir+'/probe.qml',`import QtQuick
import ${JSON.stringify(pathToFileURL(root+'/ui').href)} as Storm
Item {Storm.Engine {id:engine} Component.onCompleted:globalThis.engineProbe=engine}`);
const browser=await createBrowser({spareRenderer:false});
try {
 await browser.context.navigate(pathToFileURL(dir+'/probe.qml').href);
 for(let i=0;i<100;i++){
  const value=await browser.context.evaluate('globalThis.engineProbe ? {error:engineProbe.error, sites:engineProbe.sites.length,state:engineProbe.state?.type,frame:engineProbe.state?.frame?.kind} : {text:document.body.textContent.slice(0,1000)}');
  if(value?.state || value?.error || value?.text){console.log(JSON.stringify(value));break;}
  await Bun.sleep(50);
 }
}finally{browser.close();await rm(dir,{recursive:true,force:true});}

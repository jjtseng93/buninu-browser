// Build-time smoke test: no Wayland socket, GPU, Rust compiler or native Qt.
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {startEngine} from './runtime.mjs';
const root=process.env.OMASTORM_ROOT||'/opt/omastorm';
const browser=process.env.BUNINU_BROWSER_ROOT||'/opt/buninu-browser';
assert.equal(Bun.version,'1.4.4','Expected the pinned oven/bun:1.4.4 runtime');
for(const name of ['TextureCheck.qml','RadarMap.qml']) {
 const source=await Bun.file(root+'/ui/'+name).text();
 assert(!source.includes('GraphicsInfo.api === GraphicsInfo.Software'),'Software policy was not prepared');
 assert(await Bun.file(root+'/ui/'+name+'.upstream').exists(),'Missing upstream backup');
}
const {loadGraphics}=await import(pathToFileURL(browser+'/lib/renderer/page-renderer.js').href);
const {fragmentSource}=await import(pathToFileURL(browser+'/lib/qml/shader/qsb.js').href);
const {compileFragment}=await import(pathToFileURL(browser+'/lib/qml/shader/fragment.js').href);
const {CanvasKit}=await loadGraphics();
for(const name of ['radar','tile','grid','texture-check']) {
 const compiled=compileFragment(CanvasKit,fragmentSource(await Bun.file(root+'/ui/shaders/'+name+'.frag.qsb').bytes()));
 compiled.effect.delete();
}
const font=CanvasKit.Typeface.MakeTypefaceFromData(await Bun.file(process.env.QT_QPA_FONTDIR+'/JetBrainsMonoNerdFontMono-Regular.ttf').bytes());
assert(font,'Font cannot be decoded');
assert([...font.getGlyphIDs('󰐊󰏤󰍉󰌾󰌌')].every(id=>id!==0),'Nerd icons missing');font.delete();
const help=Bun.spawn([process.env.OMASTORM_ENGINE_BINARY||'/usr/local/bin/omastorm-engine','--help'],{stdout:'pipe',stderr:'pipe'});
const [helpOut,helpErr,helpCode]=await Promise.all([new Response(help.stdout).text(),new Response(help.stderr).text(),help.exited]);
assert(helpCode===1 && (helpOut+helpErr).includes('Usage: omastorm-engine'),'Official engine could not execute');
// During js-udocker build the unbound ROOT/tmp path may exceed AF_UNIX's
// native path limit. Exercise the socket after binding host TMPDIR to /tmp.
if(process.argv.includes('--engine')) {
const engine=await startEngine();
try {
 await new Promise((resolve,reject)=>{
  let connection,buffer='';
  const timer=setTimeout(()=>{connection?.end();reject(Error('No engine hello'));},10000);
  Bun.connect({unix:engine.socket,socket:{
   open(s){connection=s;},
   data(s,data){buffer+=Buffer.from(data).toString();const i=buffer.indexOf('\n');if(i<0)return;
    try{const hello=JSON.parse(buffer.slice(0,i));assert.equal(hello.type,'hello');assert(hello.sites?.length>0);clearTimeout(timer);s.end();resolve();}
    catch(e){clearTimeout(timer);s.end();reject(e);}},
   error(s,e){clearTimeout(timer);reject(e);},
  }}).catch(e=>{clearTimeout(timer);reject(e);});
 });
}finally{await engine.close();}
}
const scratch=await mkdtemp('/tmp/omastorm-build-check-');
const {createBrowser}=await import(pathToFileURL(browser+'/lib/headless-shell.js').href);
const page=await createBrowser({spareRenderer:false});
try {
 const qml=scratch+'/main.qml';
 await Bun.write(qml,'import QtQuick\nRectangle {width:320;height:120;color:"white";Text {text:"Omastorm 󰐊 󰍉";font.family:"monospace";color:"black"}}');
 await page.context.navigate(pathToFileURL(qml).href);
 assert((await page.context.evaluate('document.body.innerText')).includes('Omastorm'),'QML did not render');
 assert((await page.context.screenshot({format:'png'})).length>100,'Empty screenshot');
}finally{page.close();await rm(scratch,{recursive:true,force:true});}
console.log('PASS: Bun 1.4.4, official engine executable, four software shaders, Nerd Font icons and QML screenshot'+(process.argv.includes('--engine')?', engine hello/site list':''));

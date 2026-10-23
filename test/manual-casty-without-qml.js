// bun test/manual-casty-without-qml.js /path/to/stripped/buninu-browser
// Actual Casty PTY -> CDP -> browser. An isolated xclip/OSC52 store avoids touching
// the user's clipboard. A minimal Kitty peer acknowledges file/raw support.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(Bun.argv[2]||join(import.meta.dir,'..'));
const casty=resolve(import.meta.dir,'../../casty/index.js');
const dir=mkdtempSync('/tmp/casty-without-qml-');
const clip=join(dir,'clipboard'),endpointFile=join(dir,'cdp');
mkdirSync(join(dir,'bin'));mkdirSync(join(dir,'.casty'));
writeFileSync(join(dir,'.casty/config.json'),JSON.stringify({transport:'auto',format:'auto',media:false}));
writeFileSync(clip,'initial');
writeFileSync(join(dir,'bin/xclip'),`#!${process.execPath}\nconst p=process.env.TEST_CLIPBOARD_FILE;if(Bun.argv.includes('-o'))process.stdout.write(await Bun.file(p).text());else await Bun.write(p,await Bun.stdin.text());\n`,{mode:0o755});
writeFileSync(join(dir,'browser.js'),`import {writeFileSync} from 'node:fs';
const report=(text)=>{const start=String(text).indexOf('ws://');if(String(text).includes('DevTools listening on ')&&start>=0)writeFileSync(${JSON.stringify(endpointFile)},String(text).slice(start).trim())};
const error=console.error;console.error=(...args)=>{report(args.join(' '));error(...args)};
const write=process.stderr.write.bind(process.stderr);process.stderr.write=(text,...args)=>{report(text);return write(text,...args)};
const {main}=await import(${JSON.stringify(Bun.pathToFileURL(join(root,'buninu-browser.js')).href)});await main();`);
const html=`<!doctype html><meta charset="utf-8"><title>Casty editing probe</title><style>body{margin:16px;background:#eef4f7;font:18px sans-serif}input,textarea{display:block;width:400px;margin:12px 0;font:20px monospace}textarea{height:100px}button{height:44px;min-width:140px}</style><h1>Casty 中文</h1><input id="field" value="abc中文xyz"><textarea id="multi">abcd\nxy\n12345</textarea><button id="write">API copy</button><button id="read">API paste</button><canvas id="canvas" width="200" height="60"></canvas><script>const c=document.getElementById('canvas').getContext('2d');c.fillStyle='#16a6a0';c.fillRect(0,0,200,60);document.getElementById('write').onclick=async()=>{try{await navigator.clipboard.writeText('navigator 中文');globalThis.writeStatus='ok'}catch(e){globalThis.writeStatus=e.name}};document.getElementById('read').onclick=async()=>{try{globalThis.readResult=await navigator.clipboard.readText()}catch(e){globalThis.readResult=e.name}};</script>`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}})});
let proc,ws,terminalTail='',output='',frames=0,rawFrames=0,lastRaw,oscReads=0;
const wait=async(fn,label)=>{for(let i=0;i<400;i++){if(await fn())return;await Bun.sleep(25);}throw Error('Timed out: '+label+'\n'+output.slice(-1500))};
const replies=(t,data)=>{
 const s=Buffer.from(data).toString();output=(output+s).slice(-16000);terminalTail+=s;
 const re=/\x1b_G([\s\S]*?)\x1b\\|\x1b\]52;[^;]*;([^\x07]*)(?:\x07)|\x1b\[14t|\x1b\[\?u/g;let m,last=0;
 while((m=re.exec(terminalTail))){last=re.lastIndex;
  if(m[1]!==undefined){
   const [header,payload='']=m[1].split(';');const fields=Object.fromEntries(header.split(',').map(v=>v.split('=')));
   if(fields.a==='q')t.write(`\x1b_Gi=${fields.i};${fields.f==='1111970369'?'OK Buninu1 bgra':'OK'}\x1b\\`);
   if(fields.a==='T'){
    frames++;
    if(fields.f==='1111970369'&&['f','t'].includes(fields.t)){
     const path=Buffer.from(payload,'base64').toString();
     try{lastRaw=readFileSync(path);assert.equal(lastRaw.length,Number(fields.s)*Number(fields.v)*4);rawFrames++;if(fields.t==='t')unlinkSync(path);}catch(e){output+='\nframe error '+e;}
    }
   }
  }else if(m[2]!==undefined){
   if(m[2]==='?'){oscReads++;t.write('\x1b]52;c;'+readFileSync(clip).toString('base64')+'\x07');}
   else writeFileSync(clip,Buffer.from(m[2],'base64'));
  }else if(m[0]==='\x1b[14t')t.write('\x1b[4;640;640t');
  else if(m[0]==='\x1b[?u')t.write('\x1b[?0u');
 }
 if(last)terminalTail=terminalTail.slice(last);if(terminalTail.length>100000)terminalTail=terminalTail.slice(-10000);
};
try{
 proc=Bun.spawn([process.execPath,casty,`http://127.0.0.1:${server.port}/`],{env:{...process.env,HOME:dir,PATH:join(dir,'bin')+':'+process.env.PATH,CASTY_BROWSER:join(dir,'browser.js'),TEST_CLIPBOARD_FILE:clip,TERM:'xterm-256color',TMUX:''},terminal:{cols:80,rows:32,data:replies}});
 await wait(()=>existsSync(endpointFile),'CDP startup');
 const endpoint=new URL(readFileSync(endpointFile,'utf8'));
 let pages;await wait(async()=>{pages=await fetch('http://'+endpoint.host+'/json/list').then(r=>r.json());return pages.length>0},'Casty page target');
 ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise((yes,no)=>{ws.onopen=yes;ws.onerror=no});
 let id=0;const requests=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);const p=requests.get(m.id);if(p){requests.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{requests.delete(key);reject(Error('CDP timeout: '+method+' '+JSON.stringify(params)))},8000);requests.set(key,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id:key,method,params}))});
 const run=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value};
 const key=async bytes=>{console.log('key',JSON.stringify(bytes));proc.terminal.write(bytes);await Bun.sleep(150)};
 const click=async id=>{const r=await run("document.getElementById("+JSON.stringify(id)+").getBoundingClientRect().toJSON()");const col=Math.floor((r.x+r.width/2)/8)+1,row=Math.floor((r.y+r.height/2)/20)+2;await key('\x1b[<0;'+col+';'+row+'M');await key('\x1b[<0;'+col+';'+row+'m')};
 const state=()=>run(`(()=>{const e=document.getElementById('field');return [e.value,e.selectionStart,e.selectionEnd]})()`);
 await wait(async()=>await run("!!document.getElementById('field')"),'page loaded');
 await wait(()=>rawFrames>0,'raw Kitty frame');console.log('page and raw frames ready');
 await run("document.getElementById('field').focus()");
 await key('\x01');assert.deepEqual((await state()).slice(1),[0,8]);
 await key('\x1b[C');assert.deepEqual((await state()).slice(1),[8,8]);
 await key('\x1b[1;2D');assert.deepEqual((await state()).slice(1),[7,8]);
 await key('\x03');await wait(()=>readFileSync(clip,'utf8')==='z','Ctrl-C via browser xclip');
 writeFileSync(clip,'貼上');await key('\x16');await wait(async()=>(await state())[0]==='abc中文xy貼上','Casty OSC52 paste');
 assert.ok(oscReads>0);
 await key('\x1b[1;2D');await key('\x18');await wait(async()=>(await state())[0]==='abc中文xy貼','Ctrl-X');assert.equal(readFileSync(clip,'utf8'),'上');
 await run("document.getElementById('multi').focus();document.getElementById('multi').setSelectionRange(3,3)");
 await key('\x1b[1;2B');assert.deepEqual(await run("[document.getElementById('multi').selectionStart,document.getElementById('multi').selectionEnd]"),[3,7]);
 await click('write');
 await wait(async()=>await run('globalThis.writeStatus')==='ok','navigator.writeText');assert.equal(readFileSync(clip,'utf8'),'navigator 中文');
 await click('read');
 await wait(async()=>await run('globalThis.readResult')==='navigator 中文','navigator.readText');
 assert.equal(await run("navigator.clipboard.readText().then(()=> 'allowed',e=>e.name)"),'NotAllowedError');
 await run("document.getElementById('field').focus();document.getElementById('field').setSelectionRange(1,1)");
 await Bun.sleep(150);const a=await call('Page.captureScreenshot',{format:'png'});
 await Bun.sleep(550);const b=await call('Page.captureScreenshot',{format:'png'});
 assert.notEqual(a.data,b.data,'caret blink must change pixels');
 writeFileSync(join(dir,'casty-page.png'),Buffer.from(a.data,'base64'));
 const n=rawFrames;await run("document.body.style.background='#ffccdd'");await wait(()=>rawFrames>n,'updated terminal frame');
 assert.ok(lastRaw.some(v=>v!==0));
 console.log(JSON.stringify({root,dir,frames,rawFrames,oscReads,copyPaste:true,selection:true,caretMovement:true,caretBlink:true,navigatorReadWrite:true,rendering:true}));
 await key('\x11');await Promise.race([proc.exited,Bun.sleep(2000)]);
}finally{
 ws?.close();if(proc&&proc.exitCode===null)proc.kill();proc?.terminal?.close();server.stop(true);
 writeFileSync(join(dir,'terminal.log'),output);
}

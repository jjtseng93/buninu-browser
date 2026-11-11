import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CDP} from '../tools/browser-lab.js';

async function launch(args) {
  const child=Bun.spawn([process.execPath,'index.js',...args,'--remote-debugging-port=0'],{
    cwd:new URL('..',import.meta.url).pathname,stdout:'ignore',stderr:'pipe'});
  let log='',cdp;
  const drain=(async()=>{for await(const chunk of child.stderr)log+=Buffer.from(chunk).toString();})();
  try {
    const end=Date.now()+20000;let endpoint;
    while(!(endpoint=log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1])){
      if(child.exitCode!==null||Date.now()>end)throw Error(log||'No CDP endpoint');
      await Bun.sleep(20);
    }
    cdp=new CDP(endpoint);await cdp.ready;
    const {targetInfos}=await cdp.send('Target.getTargets');
    expect(targetInfos.length).toBe(1);
    const targetId=targetInfos[0].targetId;
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
    return {cdp,targetId,endpoint,async close(){cdp.close();child.kill();await child.exited;await drain;}};
  }catch(error){cdp?.close();child.kill();await child.exited;await drain;throw error;}
}
async function until(fn){
  const end=Date.now()+20000;
  while(Date.now()<end){try{if(await fn())return;}catch{}await Bun.sleep(30);}
  throw Error('Startup page did not become ready');
}

test('headless URL loads before attach and remains the same editable target',async()=>{
  const site=Bun.serve({port:0,fetch:request=>new URL(request.url).pathname==='/redirect'
    ?Response.redirect(`http://127.0.0.1:${site.port}/page`)
    :new Response('<title>Startup page</title><input id="edit"><script>globalThis.starts=(globalThis.starts||0)+1</script>',{headers:{'content-type':'text/html'}})});
  let app;
  try{
    app=await launch(['--headless',`http://127.0.0.1:${site.port}/redirect`,'--window-size=400,300']);
    await until(async()=>await app.cdp.evaluate('document.title')==='Startup page');
    await until(async()=>(await app.cdp.send('Target.getTargetInfo',{targetId:app.targetId})).targetInfo.url.endsWith('/page'));
    expect(await app.cdp.evaluate('starts')).toBe(1);
    await app.cdp.evaluate('document.getElementById("edit").focus()');
    await app.cdp.send('Input.insertText',{text:'attached'});
    expect(await app.cdp.evaluate('document.getElementById("edit").value')).toBe('attached');
    const shot=Buffer.from((await app.cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64');
    expect([shot.readUInt32BE(16),shot.readUInt32BE(20)]).toEqual([400,300]);
    expect((await app.cdp.send('Target.getTargets')).targetInfos.map(t=>t.targetId)).toEqual([app.targetId]);
  }finally{await app?.close();site.stop(true);}
},30000);

test('quickshell-headless executes its selected local QML without client navigation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'headless-qml-'));let app;
  try{
    await Bun.write(join(dir,'shell.qml'),'import QtQuick\nimport Quickshell\nFloatingWindow { width: 120; height: 80; Rectangle { anchors.fill: parent; color: "red" } Component.onCompleted: globalThis.qmlStartupReady = 42 }');
    app=await launch(['--quickshell-headless','-p',dir,'--']);
    await until(async()=>await app.cdp.evaluate('globalThis.qmlStartupReady')===42);
    expect((await app.cdp.send('Target.getTargets')).targetInfos.length).toBe(1);
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
},30000);

test('explicit navigation waits for startup instead of being overwritten by it',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const site=Bun.serve({port:0,async fetch(request){
    const first=new URL(request.url).pathname==='/slow';if(first)await gate;
    return new Response(`<title>${first?'initial':'client'}</title>`,{headers:{'content-type':'text/html'}});
  }});let app;
  try{
    app=await launch(['--headless',`http://127.0.0.1:${site.port}/slow`]);
    const navigation=app.cdp.send('Page.navigate',{url:`http://127.0.0.1:${site.port}/next`});
    release();await navigation;
    expect(await app.cdp.evaluate('document.title')).toBe('client');
  }finally{release();await app?.close();site.stop(true);}
},30000);

test('failed initial navigation leaves the target available for client recovery',async()=>{
  const {CdpServer}=await import('../lib/cdp-server.js');
  let current='about:blank';
  const server=CdpServer.create({get url(){return current;},title:()=>current,
    async navigate(url){if(url==='https://initial.invalid/')throw Error('fixture load failure');current=url;}
  }).listen(0,'127.0.0.1',{initialUrl:'https://initial.invalid/'});
  const client=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
  try{
    await client.ready;
    const {targetInfos}=await client.send('Target.getTargets');expect(targetInfos).toHaveLength(1);
    client.sessionId=(await client.send('Target.attachToTarget',{targetId:targetInfos[0].targetId,flatten:true})).sessionId;
    await client.send('Page.navigate',{url:'https://recovered.test/'});
    expect(current).toBe('https://recovered.test/');
  }finally{client.close();server.stop(true);}
});

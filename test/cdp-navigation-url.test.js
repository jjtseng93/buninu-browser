import {test,expect} from 'bun:test';
import {CDP} from '../tools/browser-lab.js';

// The CDP target's URL and history follow where the page really is: after a
// redirect behind a link or Page.navigate, and after the page navigates itself
// (location.replace, as redirect pages like search-result trampolines do).
async function launch(url) {
  const child=Bun.spawn([process.execPath,'index.js','--headless',url,'--window-size=400,300','--remote-debugging-port=0'],{
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
    const targetId=targetInfos[0].targetId;
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});cdp.sessionId=sessionId;
    await cdp.send('Page.enable');
    return {cdp,targetId,async close(){cdp.close();child.kill();await child.exited;await drain;}};
  }catch(error){cdp?.close();child.kill();await child.exited;await drain;throw error;}
}
async function until(fn){
  const end=Date.now()+20000;
  while(Date.now()<end){try{if(await fn())return;}catch{}await Bun.sleep(30);}
  throw Error('Condition not reached');
}

test('target URL and history follow redirects and script navigations',async()=>{
  const html=body=>new Response(body,{headers:{'content-type':'text/html'}});
  const site=Bun.serve({port:0,fetch(request){
    const {pathname}=new URL(request.url);
    if(pathname==='/redirect')return Response.redirect(`http://127.0.0.1:${site.port}/landed`);
    if(pathname==='/trampoline')return html('<title>Wait</title><script>location.replace("/final")</script>');
    if(pathname==='/start')return html('<title>Start</title><a href="/redirect" style="display:block;width:400px;height:300px">go</a>');
    return html(`<title>${pathname.slice(1)}</title>`);
  }});
  const base=`http://127.0.0.1:${site.port}`;
  let app;
  try{
    app=await launch(`${base}/start`);
    const info=async()=>(await app.cdp.send('Target.getTargetInfo',{targetId:app.targetId})).targetInfo;
    await until(async()=>await app.cdp.evaluate('document.title')==='Start');
    // A link through a redirect records where it ended.
    await app.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:50,y:50,button:'left',clickCount:1});
    await app.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:50,y:50,button:'left',clickCount:1});
    await until(async()=>(await info()).url===`${base}/landed`);
    // Page.navigate through a redirect.
    await app.cdp.send('Page.navigate',{url:`${base}/redirect`});
    expect((await info()).url).toBe(`${base}/landed`);
    // The page replaces itself from script.
    await app.cdp.send('Page.navigate',{url:`${base}/trampoline`});
    await until(async()=>(await info()).url===`${base}/final`);
    expect(await app.cdp.evaluate('location.href')).toBe(`${base}/final`);
    const {currentIndex,entries}=await app.cdp.send('Page.getNavigationHistory');
    expect(entries[currentIndex].url).toBe(`${base}/final`);
    expect(entries[currentIndex].title).toBe('final');
  }finally{await app?.close();site.stop(true);}
},60000);

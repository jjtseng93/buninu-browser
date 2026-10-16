#!/usr/bin/env bun
// Development-only CDP comparison runner. No package dependencies or page patches.
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.next = 1; this.pending = new Map(); this.events = [];
    this.ready = new Promise((yes, no) => { this.ws.addEventListener('open', yes, {once:true}); this.ws.addEventListener('error', no, {once:true}); });
    this.ws.addEventListener('message', ({data}) => {
      const m = JSON.parse(data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.no(Error(JSON.stringify(m.error))) : p.yes(m.result); }
      else { this.events.push({time:performance.now(), ...m}); if(this.events.length>3000)this.events.shift(); }
    });
    this.ws.addEventListener('close', () => { for(const p of this.pending.values()){clearTimeout(p.timer);p.no(Error('CDP closed'));} this.pending.clear(); });
  }
  async send(method, params={}, timeout=30000) {
    await this.ready;
    return new Promise((yes,no) => { const id=this.next++; const timer=setTimeout(()=>{this.pending.delete(id);no(Error(`${method} timed out`));},timeout);this.pending.set(id,{yes,no,timer});this.ws.send(JSON.stringify({id,method,params,...(this.sessionId?{sessionId:this.sessionId}:{})})); });
  }
  async evaluate(expression, timeout=10000) { const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(r.exceptionDetails)throw Error(r.exceptionDetails.text+' '+(r.exceptionDetails.exception?.description||''));return r.result?.value; }
  close(){this.ws.close();}
}
export async function launch(engine, dir, extra=[]) {
  mkdirSync(dir,{recursive:true});
  const log=join(dir,engine+'.log');
  const cmd=engine==='chromium' ? ['/usr/local/bin/chromium-headless-shell','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=0','--window-size=1280,800',...extra,'about:blank'] : [process.execPath,resolve('buninu-browser.js'),'--remote-debugging-port=0',...extra];
  const proc=Bun.spawn(cmd,{stdout:Bun.file(join(dir,engine+'.stdout')),stderr:'pipe',env:{...process.env,BUNINU_LOG:join(dir,'buninu-diagnostic.log')}});
  let stderr='';const writer=Bun.file(log).writer();
  (async()=>{for await(const chunk of proc.stderr){writer.write(chunk);stderr+=Buffer.from(chunk).toString();if(stderr.length>200000)stderr=stderr.slice(-100000);}await writer.end();})();
  let cdp;
  try {
  let port;for(let i=0;i<200;i++){const m=stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/);if(m){port=Number(m[1]);break;}if(proc.exitCode!==null)throw Error(`engine exited ${proc.exitCode}: ${stderr.slice(-1000)}`);await Bun.sleep(50);}
  if(!port){proc.kill();throw Error('CDP endpoint missing');}
  const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  cdp=new CDP(version.webSocketDebuggerUrl);await cdp.ready;
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  cdp.sessionId=sessionId;
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  return {cdp,proc,stop:async()=>{cdp.close();proc.kill();await proc.exited;}};
  } catch(error) { cdp?.close();proc.kill();await proc.exited;throw error; }
}
const describe = `(()=>({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,12000),nodes:document.querySelectorAll('*').length,readyState:document.readyState,controls:[...document.querySelectorAll('a,button,input,select,summary,[role="button"]')].map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim().slice(0,100),href:e.getAttribute('href'),id:e.id,x:r.x,y:r.y,width:r.width,height:r.height};}).filter(e=>e.width>0&&e.height>0&&e.x<1280&&e.y<800&&e.x+e.width>0&&e.y+e.height>0).slice(0,100)}))()`;
export async function snapshot(cdp,dir,name) {
  const start=performance.now(); const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});const captureMs=performance.now()-start;
  await Bun.write(join(dir,name+'.png'),Buffer.from(data,'base64'));
  let dom;try{dom=await cdp.evaluate(describe);}catch(error){dom={error:error.message};}
  await Bun.write(join(dir,name+'.json'),JSON.stringify({...dom,captureMs},null,2));return {captureMs,...dom};
}
export async function runCase({engine,url,dir,actions=[],settle=1500}) {
  const started=performance.now();let browser;const report={engine,url,actions:[]};
  try {
    browser=await launch(engine,dir);const {cdp}=browser;report.startupMs=performance.now()-started;
    const nav=performance.now();await cdp.send('Page.navigate',{url},45000);report.navigateReplyMs=performance.now()-nav;
    const deadline=performance.now()+30000;
    while(performance.now()<deadline&&!cdp.events.some(e=>e.method==='Page.loadEventFired'&&e.time>=nav))await Bun.sleep(100);
    const loaded=cdp.events.find(e=>e.method==='Page.loadEventFired'&&e.time>=nav);report.loadMs=loaded?loaded.time-nav:null;
    await Bun.sleep(settle);report.initial=await snapshot(cdp,dir,'initial');
    for(let i=0;i<actions.length;i++){
      const action=actions[i],at=performance.now();let error=null;
      try {
        if(action.click||action.clickText){const point=await cdp.evaluate(`(()=>{const candidates=[...document.querySelectorAll(${JSON.stringify(action.click||'button,a,summary,[role="button"],[role="menuitem"]')})];const e=candidates.find(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&(!${JSON.stringify(action.clickText||'')}||(e.innerText||e.getAttribute('aria-label')||'').trim()===${JSON.stringify(action.clickText||'')});});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(!point)throw Error('visible selector not found');for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});}
        else if(action.point){for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:action.point[0],y:action.point[1],button:'left',clickCount:1});}
        else if(action.type)await cdp.send('Input.insertText',{text:action.type});
        else if(action.key){for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:action.key,code:action.key,windowsVirtualKeyCode:action.key==='Enter'?13:action.key==='Escape'?27:0});}
        else if(action.scroll)await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:640,y:500,deltaY:action.scroll,deltaX:0});
        else if(action.evaluate)report.lastEvaluation=await cdp.evaluate(action.evaluate);
      }catch(e){error=e.message;}
      await Bun.sleep(action.wait??600);
      const state=await snapshot(cdp,dir,`action-${i+1}`);report.actions.push({action,error,elapsedMs:performance.now()-at,state});
    }
    report.errors=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').slice(-20);
  }catch(error){report.error=error.stack;}finally{await browser?.stop();report.totalMs=performance.now()-started;await Bun.write(join(dir,'report.json'),JSON.stringify(report,null,2));}
  return report;
}
if(import.meta.main){const [engine,url,dir,...rest]=process.argv.slice(2);if(!engine||!url||!dir)throw Error('usage: bun tools/browser-lab.js ENGINE URL OUTPUT_DIR [ACTIONS_JSON]');const result=await runCase({engine,url,dir:resolve(dir),actions:rest[0]?JSON.parse(rest[0]):[]});console.log(JSON.stringify({engine,url,error:result.error,startupMs:result.startupMs,loadMs:result.loadMs,captureMs:result.initial?.captureMs,title:result.initial?.title,actions:result.actions.map(a=>({action:a.action,error:a.error,url:a.state?.url}))}));}

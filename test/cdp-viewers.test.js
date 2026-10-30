import {test, expect} from 'bun:test';
import {CdpServer} from '../lib/cdp-server.js';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await Bun.sleep(5);}throw Error('viewer update timed out');};
async function connect(url){
  const ws=new WebSocket(url), events=[], pending=new Map();let id=0;
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);};
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  return {ws,events,send(method,params={},sessionId){return new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});}};
}
for(const direct of [false,true])test(`independent viewer ACK, stop and disconnect (${direct?'page sockets':'sessions'})`,async()=>{
  let frame;const server=CdpServer.create({screenshot:options=>options.format??'png',onFrame:fn=>frame=fn}).listen(0);
  const clients=[];
  try{
    const root=await connect(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);clients.push(root);
    const {targetId}=await root.send('Target.createTarget',{url:'about:blank'});
    async function viewer(){const c=await connect(`ws://127.0.0.1:${server.port}/devtools/${direct?'page/'+targetId:'browser/cdp-server'}`);clients.push(c);const sid=direct?undefined:(await c.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;return {c,sid,send:(m,p)=>c.send(m,p,sid),frames:()=>c.events.filter(e=>e.method==='Page.screencastFrame')};}
    const a=await viewer(),b=await viewer();
    await a.send('Page.startScreencast',{format:'png'});await b.send('Page.startScreencast',{format:'jpeg'});
    await until(()=>a.frames().length===1&&b.frames().length===1);
    expect(a.frames()[0].params.data).toBe('png');expect(b.frames()[0].params.data).toBe('jpeg');
    frame();await until(()=>a.frames().length===2&&b.frames().length===2);
    for(let i=0;i<5;i++)frame();
    // A cannot ACK B's frames, even when both watch the same target.
    await a.send('Page.screencastFrameAck',{sessionId:b.frames()[0].params.sessionId});
    await Bun.sleep(20);expect(a.frames()).toHaveLength(2);expect(b.frames()).toHaveLength(2);
    await b.send('Page.screencastFrameAck',{sessionId:b.frames()[0].params.sessionId});await until(()=>b.frames().length===3);
    expect(a.frames()).toHaveLength(2);
    await a.send('Page.stopScreencast');
    await b.send('Page.screencastFrameAck',{sessionId:b.frames()[1].params.sessionId});frame();await until(()=>b.frames().length===4);
    a.c.ws.close();await Bun.sleep(20);
    await b.send('Page.screencastFrameAck',{sessionId:b.frames()[2].params.sessionId});frame();await until(()=>b.frames().length===5);
    const replacement=await viewer();await replacement.send('Page.startScreencast');await until(()=>replacement.frames().length===1);
    await b.send('Page.stopScreencast');frame();await until(()=>replacement.frames().length===2);
    if(!direct){
      await expect(root.send('Page.stopScreencast',{},b.sid)).rejects.toThrow('No session owned');
      const {sessionId}=await replacement.c.send('Target.attachToTarget',{targetId,flatten:true});
      await replacement.c.send('Page.startScreencast',{format:'jpeg'},sessionId);
      await until(()=>replacement.c.events.some(e=>e.method==='Page.screencastFrame'&&e.sessionId===sessionId));
      await replacement.send('Page.stopScreencast');frame();
      await until(()=>replacement.c.events.filter(e=>e.method==='Page.screencastFrame'&&e.sessionId===sessionId).length===2);
    }
  }finally{for(const c of clients)c.ws.close();server.stop(true);}
});

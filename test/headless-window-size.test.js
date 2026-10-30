import {test,expect} from 'bun:test';
import {parseWindowSize} from '../lib/window-size.js';
import {CDP} from '../tools/browser-lab.js';
test('window size defaults and validation',()=>{
  expect(parseWindowSize([])).toEqual({width:800,height:600});
  expect(parseWindowSize(['--window-size=1920,1080'])).toEqual({width:1920,height:1080});
  expect(parseWindowSize(['--window-size=640x480'])).toEqual({width:640,height:480});
  for(const size of ['', '0,600','-1,600','800,','800,600,1','1.5,600','9007199254740992,600'])
    expect(()=>parseWindowSize(['--window-size='+size])).toThrow('positive integers');
});
test('persistent headless CLI size reaches renderer, CDP targets and captures; CDP can override it',async()=>{
  const child=Bun.spawn([process.execPath,'index.js','--headless','--window-size=960,540','--remote-debugging-port=0'],{cwd:new URL('..',import.meta.url).pathname,stdout:'ignore',stderr:'pipe'});
  let client;const reader=child.stderr.getReader();
  const deadline=setTimeout(()=>child.kill(),20000);let log='';
  try{
    let match;
    while(!(match=log.match(/DevTools listening on (ws:\/\/\S+)/))){const {value,done}=await reader.read();if(done)throw Error(log);log+=new TextDecoder().decode(value);}
    client=new CDP(match[1]);await client.ready;
    const {targetId}=await client.send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await client.send('Target.attachToTarget',{targetId,flatten:true});client.sessionId=sessionId;
    const target=await client.send('Target.getTargetInfo',{targetId});expect(target.targetInfo.viewport).toMatchObject({width:960,height:540});
    const metrics=await client.send('Page.getLayoutMetrics');expect(metrics.cssVisualViewport).toMatchObject({clientWidth:960,clientHeight:540});
    const capture=await client.send('Page.captureScreenshot',{format:'png'});const png=Buffer.from(capture.data,'base64');
    expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([960,540]);
    await client.send('Emulation.setDeviceMetricsOverride',{width:640,height:360,deviceScaleFactor:1,mobile:false});
    const resized=await client.send('Page.getLayoutMetrics');expect(resized.cssVisualViewport).toMatchObject({clientWidth:640,clientHeight:360});
  }finally{clearTimeout(deadline);client?.close();reader.releaseLock();child.kill();await child.exited;}
},25000);

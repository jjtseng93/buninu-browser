import {test,expect} from 'bun:test';
import {attachQmlClipboard} from '../lib/qml/wayland-clipboard.js';
test('QML clipboard endpoint is lazy, reused and closed; HTML navigation needs none',async()=>{
 let finish;const done=new Promise(r=>finish=r),scripts=[],visits=[];
 const navigate=async url=>visits.push(url);
 const browser={context:{navigate,addInitScript:async s=>scripts.push(s)}};
 const client={clipboard:{read:async()=> 'text',write:async()=>{}}};
 try{
  await attachQmlClipboard(client,browser,done);
  await browser.context.navigate('about:blank');
  await browser.context.navigate('https://example.test/');
  expect(scripts.length).toBe(0);
  await browser.context.navigate('file:///tmp/app.qml');
  expect(scripts.length).toBe(1);
  await browser.context.navigate('file:///tmp/other.qml');
  expect(scripts.length).toBe(1);
  const endpoint=JSON.parse(scripts[0].match(/setClipboardEndpoint\((.*)\);/)[1]);
  const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({operation:'read'})});
  expect(await response.json()).toEqual({text:'text'});
  expect(visits.length).toBe(4);
  finish();await Bun.sleep(5);
  expect(browser.context.navigate).toBe(navigate);
  await expect(fetch(endpoint,{method:'POST',body:'{}'})).rejects.toThrow();
 }finally{finish();}
});

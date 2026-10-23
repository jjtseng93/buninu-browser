import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {launch} from '../frontends/wayland/index.js';
test.skipIf(process.env.BUNINU_TEST_WAYLAND!=='1')('QML uses shared input defaults and exchanges text through Land on demand',async()=>{
 const {start}=await import('../../buninu-land/compositor.js');
 const dir=mkdtempSync('/tmp/qml-clipboard-'),old=process.env.XDG_RUNTIME_DIR;
 let land,app;const writes=[];
 const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await Bun.sleep(25);}throw Error('Clipboard did not settle');};
 try {
  process.env.XDG_RUNTIME_DIR=dir;
  await Bun.write(join(dir,'main.qml'),`import QtQuick
Rectangle {width:400;height:150;color:"white"
TextInput {id:field;x:10;y:10;width:300;height:30;text:"abc中文"}
Button {id:all;x:10;y:70;onClicked:{field.forceActiveFocus();field.selectAll()}}
Button {id:copy;x:100;y:70;onClicked:field.copy()}
}`);
  land=await start(['--remote-debugging-port=0','--window-size=640,480']);
  land.compositor.clipboard.host={write:async text=>writes.push(text),read:async()=>{throw Error('Unexpected external read');},close(){}};
  app=await launch({url:'about:blank',chrome:false,socket:join(dir,'wayland-buninu')});
  await app.browser.context.navigate(Bun.pathToFileURL(join(dir,'main.qml')).href);
  const run=s=>app.browser.context.evaluate(s);
  await wait(()=>app.client.clipboard.serial>0);
  await run(`document.getElementById('all').click()`);
  const key=async(key,modifiers=0)=>{
    for(const type of ['keyDown','keyUp'])land.context.dispatchKeyEvent({type,key,code:'Key'+key.toUpperCase(),modifiers});
    await Bun.sleep(100);
  };
  await key('c',2);await wait(()=>writes.length>0);expect(writes.at(-1)).toBe('abc中文');
  await key('ArrowRight');await key('v',2);
  await wait(async()=>await run(`document.getElementById('field').value`)==='abc中文abc中文');
  await key('a',2);await key('x',2);
  await wait(async()=>await run(`document.getElementById('field').value`)==='');
  expect(writes.at(-1)).toBe('abc中文abc中文');
  await key('v',2);await wait(async()=>await run(`document.getElementById('field').value`)==='abc中文abc中文');
  await run(`document.getElementById('all').click()`);
  const before=writes.length;await run(`document.getElementById('copy').click()`);
  await wait(()=>writes.length>before);expect(writes.at(-1)).toBe('abc中文abc中文');
 }finally{app?.close();land?.close();if(old===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=old;rmSync(dir,{recursive:true,force:true});}
},30000);

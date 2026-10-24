import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createBrowser} from '../lib/headless-shell.js';

test('local QML Socket connects, splits UTF-8 messages, writes and disconnects',async()=>{
 const dir=await mkdtemp('/tmp/qml-socket-');
 const peers=new Set(); let received='';
 const server=createServer(socket=>{
  peers.add(socket);socket.on('close',()=>peers.delete(socket));
  socket.on('data',data=>{received+=data;});
  const bytes=Buffer.from('你好\nsecond\n');
  socket.write(bytes.subarray(0,2));setTimeout(()=>socket.write(bytes.subarray(2)),20);
 });
 await new Promise(r=>server.listen(dir+'/engine.sock',r));
 const browser=await createBrowser({spareRenderer:false});
 try{
  await Bun.write(dir+'/main.qml',`import QtQuick\nimport QtQuick.Window\nimport Quickshell.Io
Item { Socket { id: socket; path: ${JSON.stringify(dir+'/engine.sock')}; connected: true
 parser: SplitParser { onRead: data => { globalThis.messages.push(data); socket.write(data + "!"); socket.flush(); } }
 onConnectedChanged: (globalThis.states ??= []).push(connected)
 Component.onCompleted: { globalThis.messages=[]; globalThis.states=[]; globalThis.sock=socket; }
} }`);
  await browser.context.navigate('file://'+dir+'/main.qml');
  for(let i=0;i<100;i++){if(await browser.context.evaluate('globalThis.messages?.length===2'))break;await Bun.sleep(20);}
  expect(await browser.context.evaluate('messages')).toEqual(['你好','second']);
  expect(await browser.context.evaluate('sock.connected')).toBe(true);
  for(let i=0;i<100&&!received.includes('second!');i++)await Bun.sleep(10);
  expect(received).toBe('你好!second!');
  await browser.context.evaluate('sock.connected=false');
  for(let i=0;i<100&&peers.size;i++)await Bun.sleep(10);
  expect(peers.size).toBe(0);
  expect(await browser.context.evaluate('sock.connected')).toBe(false);
 }finally{browser.close();for(const p of peers)p.destroy();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
},20000);

test('Socket failure can reconnect and navigation closes the live connection',async()=>{
 const dir=await mkdtemp('/tmp/qml-socket-retry-');
 const peers=new Set();
 const server=createServer(s=>{peers.add(s);s.on('close',()=>peers.delete(s));});
 const browser=await createBrowser({spareRenderer:false});
 try{
  await Bun.write(dir+'/main.qml',`import QtQuick\nimport Quickshell.Io
Item { Socket {id:s; path:${JSON.stringify(dir+'/retry.sock')};connected:true
onError:error=>{globalThis.socketError=error;}
Component.onCompleted:globalThis.socketObject=s
} }`);
  await browser.context.navigate('file://'+dir+'/main.qml');
  for(let i=0;i<100;i++){if(await browser.context.evaluate('!!globalThis.socketError'))break;await Bun.sleep(10);}
  expect(await browser.context.evaluate('socketObject.connected')).toBe(false);
  expect(await browser.context.evaluate('socketError')).toBe('ENOENT');
  await new Promise(r=>server.listen(dir+'/retry.sock',r));
  await browser.context.evaluate('socketObject.connected=true');
  for(let i=0;i<100;i++){if(await browser.context.evaluate('socketObject.connected'))break;await Bun.sleep(10);}
  expect(await browser.context.evaluate('socketObject.connected')).toBe(true);
  await browser.context.navigate('data:text/html,<p>ordinary page</p>');
  for(let i=0;i<100&&peers.size;i++)await Bun.sleep(10);
  expect(peers.size).toBe(0);
 }finally{browser.close();for(const p of peers)p.destroy();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
},20000);

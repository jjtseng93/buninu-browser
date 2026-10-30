import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';
import {CdpServer} from '../lib/cdp-server.js';
import {CDP} from '../tools/browser-lab.js';
test('file input opens browser-owned picker, selects files, and FileReader emits asynchronous load',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buninu-picker-'));await Bun.write(join(dir,'one.txt'),'Hello 選檔');await Bun.write(join(dir,'two.txt'),'second');
 const b=await createBrowser({spareRenderer:false}),server=CdpServer.create(b.context).listen(0),c=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
 try{
  await c.send('Page.navigate',{url:'data:text/html,'+encodeURIComponent(`<input id="f" type="file" multiple><script>window.events=[];f.oninput=()=>events.push('input');f.onchange=async()=>{events.push('change');window.names=[...f.files].map(f=>f.name);const r=new FileReader();r.onload=e=>{window.text=e.target.result;events.push('load')};r.readAsText(f.files[0]);};</script>`)});
  await c.evaluate('f.click();window.clickReturned=true');
  for(let i=0;i<200&&!b.context.dialogState;i++)await Bun.sleep(10);
  expect(b.context.dialogState?.type).toBe('file');
  const action=async value=>{await c.evaluate(`window.__fileAction=${JSON.stringify(value)}`);await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift'});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift'});};
  await action({kind:'browse',path:dir});
  expect(await c.evaluate('document.body.textContent.includes("one.txt")')).toBe(true);
  await action({kind:'select',index:0});await action({kind:'select',index:1});await action({kind:'open'});
  for(let i=0;i<100;i++){if(await c.evaluate('window.text!==undefined'))break;await Bun.sleep(10);}
  expect(await c.evaluate('clickReturned')).toBe(true);expect(await c.evaluate('names')).toEqual(['one.txt','two.txt']);
  expect(await c.evaluate('text')).toBe('Hello 選檔');expect(await c.evaluate('events')).toEqual(['input','change','load']);
  expect(await c.evaluate('f.value')).toBe('C:\\fakepath\\one.txt');
  expect(await c.evaluate('f.value="";({length:f.files.length,value:f.value})')).toEqual({length:0,value:''});
 }finally{c.close();server.stop(true);b.close();await rm(dir,{recursive:true,force:true});}
},30000);

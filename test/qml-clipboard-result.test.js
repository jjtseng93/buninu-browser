import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowser} from '../lib/headless-shell.js';

test('QML clipboard reports write failure but retains local text on denied or empty host reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-clipboard-result-'));
 const file=join(dir,'main.qml');await Bun.write(file,'import QtQuick\nText {text:"clipboard"}');
 const browser=await createBrowser({spareRenderer:false});
 try {
  await browser.context.addInitScript(`globalThis.clipState={text:'initial',failRead:false,failWrite:false};
   __qmlHost.clipboardRead=async()=>{if(clipState.failRead)throw Error('read denied');return clipState.text};
   __qmlHost.clipboardWrite=async text=>{if(clipState.failWrite)throw Error('write denied');clipState.text=text};`);
  await browser.context.navigate(Bun.pathToFileURL(file).href);
  const run=s=>browser.context.evaluate(s);
  expect(await run(`__qmlRuntime.Quickshell.writeClipboardText('copied').then(()=>clipState.text)`)).toBe('copied');
  expect(await run(`clipState.text='external';__qmlRuntime.Quickshell.readClipboardText({strict:true})`)).toBe('external');
  expect(await run(`clipState.text='';__qmlRuntime.Quickshell.readClipboardText({strict:true})`)).toBe('external');
  expect(await run(`clipState.failRead=true;__qmlRuntime.Quickshell.readClipboardText({strict:true})`)).toBe('external');
  expect(await run(`__qmlRuntime.Quickshell.readClipboardText()`)).toBe('external');
  expect(await run(`clipState.failWrite=true;__qmlRuntime.Quickshell.writeClipboardText('bad').then(()=>false,e=>e.message)`)).toBe('write denied');
  expect(await run(`__qmlRuntime.Quickshell.readClipboardText()`)).toBe('bad');
 } finally {browser.close();rmSync(dir,{recursive:true,force:true})}
},30000);

import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';

test('local QML reports real bytecode hits across reload; ordinary HTML has no cache capability',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-cache-page-'));
 const previous=process.env.BUNINU_QML_CACHE;process.env.BUNINU_QML_CACHE='bytecode';
 const b=await createBrowser({spareRenderer:false});
 try{
  await Bun.write(join(dir,'Card.qml'),'import QtQuick\nRectangle { width: 80; height: 40; color: "red"; Text { id: label; text: "cached card" }; readonly property alias labelItem: label }');
  await Bun.write(join(dir,'Main.qml'),'import QtQuick\nItem { width: 200; height: 100; Loader { source: "Card.qml" } }');
  const url=Bun.pathToFileURL(join(dir,'Main.qml')).href;
  for(let i=0;i<2;i++){
   if(i===0)await b.context.navigate(url);else await b.context.reload();
   let stats;
   for(let n=0;n<50;n++){
    stats=await b.context.evaluate('navigator.buninu.qmlCache');
    if(stats.bytecode.confirmedHits===1)break;
    await Bun.sleep(40);
   }
   expect(stats.mode).toBe('bytecode');expect(stats.bytecode.confirmedHits).toBe(1);
   expect(stats.hits).toBe(i);expect(stats.misses).toBe(1-i);
   expect(await b.context.evaluate('document.body.innerText')).toContain('cached card');
   expect(await b.context.evaluate('Object.isFrozen(navigator.buninu.qmlCache)')).toBe(true);
  }
  await b.context.navigate('data:text/html,<h1>web</h1>');
  expect(await b.context.evaluate('typeof navigator.buninu')).toBe('undefined');
 }finally{
  b.close();if(previous===undefined)delete process.env.BUNINU_QML_CACHE;else process.env.BUNINU_QML_CACHE=previous;
  rmSync(dir,{recursive:true,force:true});
 }
},30000);

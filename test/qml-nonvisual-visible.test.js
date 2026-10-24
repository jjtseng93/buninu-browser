import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';

test('dynamic QtObject readonly visible does not abort singleton initialization',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-nonvisual-'));let browser;
 try{
  await Bun.write(join(dir,'qmldir'),'singleton Sound 1.0 Sound.qml\n');
  await Bun.write(join(dir,'Sound.qml'),'pragma Singleton\nimport QtQuick\nQtObject { property int held: -1; readonly property real gain: held < 0 ? 1 : 0 }');
  await Bun.write(join(dir,'Panel.qml'),'import QtQuick\nimport "."\nItem { QtObject { id:meta; readonly property bool visible: true; readonly property real gain: Sound.gain } Text { text: "gain="+meta.gain+" visible="+meta.visible } }');
  await Bun.write(join(dir,'main.qml'),'import QtQuick\nItem { width:200;height:80; Loader { id:loader;source:"Panel.qml" } }');
  browser=await createBrowser({spareRenderer:false});
  await browser.context.navigate(Bun.pathToFileURL(join(dir,'main.qml')).href);
  expect(await browser.context.evaluate('Array.from(document.querySelectorAll("[data-qml-type=Text]")).map(e=>e.textContent).join(" ")')).toContain('gain=1 visible=true');
  expect(await browser.context.evaluate('Array.from(document.querySelectorAll("[data-qml-type=QtObject]")).every(e=>e.style.display==="none")')).toBe(true);
 }finally{browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);
